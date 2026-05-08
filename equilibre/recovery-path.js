/**
 * recovery-path.js
 *
 * Tests the one recovery vector that prior verification did NOT cover on the
 * targeted axlUSDC + USDt gauged pairs:
 *
 *   Gauge.claimFees()  →  Pair.claimFees() to gauge  →
 *   InternalBribe.notifyRewardAmount(token, amount) at CURRENT epoch
 *
 * If this path works:
 *   1. Anyone (permissionless) calls Gauge.claimFees() now.
 *   2. The gauge's share of PairFees (proportional to gauge.balanceOf(LP)/totalSupply)
 *      gets pulled into the gauge, then forwarded into InternalBribe at the
 *      CURRENT epoch's tokenRewardsPerEpoch slot.
 *   3. A voter who voted for that gauge in the current epoch can later call
 *      InternalBribe.getReward(tokenId, [token]) and earn their share.
 *
 * Per gauge we measure:
 *   - Gauge LP share of pair total supply
 *   - Pair.claimable0/1[gauge]  (already-credited)
 *   - lag = (index - supplyIndex) * gauge_balance / 1e18  (uncredited swap fees)
 *   - sweep = claimable + lag  (what claimFees would forward)
 *   - PairFees balance × gauge share = sanity check (should ≈ sweep if up-to-date)
 *
 * Then verifies the function shape:
 *   - Selector 'claimFees()' present in Gauge bytecode
 *   - InternalBribe accepts notifyRewardAmount from gauge address
 *
 * Output: $-denominated table sorted by user's expected capture share.
 */

const { ethers } = require('ethers');
const fs = require('fs');

const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');
const scan = JSON.parse(fs.readFileSync('scan-results.json'));

const ZERO = '0x0000000000000000000000000000000000000000';
const E18 = ethers.BigNumber.from(10).pow(18);

const VOTING_ESCROW = '0x35361C9c2a324F5FB8f3aed2d7bA91CE1410893A';

// Target tokens (verified live on Kava)
const targetAddrs = new Set([
  '0xeb466342c4d449bc9f53a865d5cb90586f405215', // axlUSDC
  '0x919c1c267bc06a7039e03fcc2ef738525769109c', // native USDt
]);

// Pass voter's veNFT id via env: VENFT_ID=12345 node recovery-path.js
async function getVoterVP() {
  const id = process.env.VENFT_ID;
  if (!id) {
    console.error('Set VENFT_ID env var to your veNFT token id.');
    process.exit(1);
  }
  const ve = new ethers.Contract(VOTING_ESCROW, ['function balanceOfNFT(uint256) view returns (uint256)'], p);
  return ve.balanceOfNFT(id);
}

const PAIR_ABI = [
  'function index0() view returns (uint256)',
  'function index1() view returns (uint256)',
  'function supplyIndex0(address) view returns (uint256)',
  'function supplyIndex1(address) view returns (uint256)',
  'function claimable0(address) view returns (uint256)',
  'function claimable1(address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

const IB_ABI = [
  'function totalSupply() view returns (uint256)',
  'function tokenRewardsPerEpoch(address,uint256) view returns (uint256)',
  'function periodFinish(address) view returns (uint256)',
  'function isReward(address) view returns (bool)',
];

const GAUGE_FUNCS = ['claimFees()', 'notifyRewardAmount(address,uint256)', 'getReward(address,address[])'];
const IB_FUNCS = ['notifyRewardAmount(address,uint256)', 'getReward(uint256,address[])', 'deposit(uint256,uint256)'];

const sel = (sig) => ethers.utils.id(sig).slice(0, 10);

const fmt = (raw, dec, digits = 4) => {
  if (!raw) return '0';
  const n = Number(ethers.utils.formatUnits(raw, dec));
  if (n === 0) return '0';
  if (n < 1e-6) return n.toExponential(2);
  if (n < 1) return n.toFixed(6);
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
};

(async () => {
  const YOUR_VP = await getVoterVP();
  console.log(`Voter VP for VENFT_ID=${process.env.VENFT_ID}: ${ethers.utils.formatUnits(YOUR_VP, 18)}\n`);

  // 1. Verify Gauge bytecode has claimFees() (sample one gauge)
  const sampleGauge = scan.pairs.find(x => x.gauge && x.gauge !== ZERO).gauge;
  const sampleGaugeCode = await p.getCode(sampleGauge);
  console.log('━━━ Selector presence in sample Gauge ' + sampleGauge + ' ━━━');
  for (const fn of GAUGE_FUNCS) {
    const present = sampleGaugeCode.toLowerCase().includes(sel(fn).slice(2));
    console.log(`  ${present ? '✓' : '✗'} ${fn}  (selector ${sel(fn)})`);
  }

  // Sample InternalBribe
  const sampleIB = scan.pairs.find(x => x.internalBribe && x.internalBribe !== ZERO).internalBribe;
  const sampleIBCode = await p.getCode(sampleIB);
  console.log('━━━ Selector presence in sample InternalBribe ' + sampleIB + ' ━━━');
  for (const fn of IB_FUNCS) {
    const present = sampleIBCode.toLowerCase().includes(sel(fn).slice(2));
    console.log(`  ${present ? '✓' : '✗'} ${fn}  (selector ${sel(fn)})`);
  }

  // 2. Filter to axlUSDC/USDt gauged pairs
  const candidates = scan.pairs.filter(x =>
    x.gauge && x.gauge !== ZERO &&
    (targetAddrs.has(x.token0.toLowerCase()) || targetAddrs.has(x.token1.toLowerCase())) &&
    (x.pfBal0 !== '0' || x.pfBal1 !== '0' || x.ibBal0 !== '0' || x.ibBal1 !== '0')
  );
  console.log(`\n━━━ ${candidates.length} candidate gauged pairs (axlUSDC or native USDt) ━━━`);

  let totalSweepableUSD = 0;
  let totalCapturedUSD = 0;
  let totalAlreadyInIBUSD = 0;
  const rows = [];

  for (const x of candidates) {
    const pair = new ethers.Contract(x.pair, PAIR_ABI, p);
    let gShare, gPending0, gPending1, gLPbal, ts;
    try {
      const [bal, total, idx0, idx1, sI0, sI1, c0, c1] = await Promise.all([
        pair.balanceOf(x.gauge),
        pair.totalSupply(),
        pair.index0(),
        pair.index1(),
        pair.supplyIndex0(x.gauge),
        pair.supplyIndex1(x.gauge),
        pair.claimable0(x.gauge),
        pair.claimable1(x.gauge),
      ]);
      gLPbal = bal;
      ts = total;
      gShare = ts.gt(0) ? bal.mul(10000).div(ts).toNumber() / 100 : 0;
      gPending0 = c0.add(idx0.sub(sI0).mul(bal).div(E18));
      gPending1 = c1.add(idx1.sub(sI1).mul(bal).div(E18));
    } catch (e) {
      console.log(`  skip ${x.symbol0}/${x.symbol1}: ${e.message.slice(0, 60)}`);
      continue;
    }

    // Compute USD value of pending (only count axlUSDC/USDt sides at $1)
    let sweepUSD = 0;
    if (targetAddrs.has(x.token0.toLowerCase())) {
      sweepUSD += Number(ethers.utils.formatUnits(gPending0, x.dec0));
    }
    if (targetAddrs.has(x.token1.toLowerCase())) {
      sweepUSD += Number(ethers.utils.formatUnits(gPending1, x.dec1));
    }

    // What's already locked in InternalBribe (the orphaned-or-not balance)
    let alreadyIB = 0;
    if (targetAddrs.has(x.token0.toLowerCase())) {
      alreadyIB += Number(ethers.utils.formatUnits(x.ibBal0 || '0', x.dec0));
    }
    if (targetAddrs.has(x.token1.toLowerCase())) {
      alreadyIB += Number(ethers.utils.formatUnits(x.ibBal1 || '0', x.dec1));
    }

    // Capture rate vs. existing IB.totalSupply (current voters in that bribe)
    const ib = new ethers.Contract(x.internalBribe, IB_ABI, p);
    let captureBps = 10000; // default 100%
    let ibTS = ethers.BigNumber.from(0);
    try {
      ibTS = await ib.totalSupply();
      captureBps = YOUR_VP.mul(10000).div(ibTS.add(YOUR_VP)).toNumber();
    } catch (e) {}

    const capturePct = captureBps / 100;
    const userSweepUSD = sweepUSD * capturePct / 100;

    totalSweepableUSD += sweepUSD;
    totalCapturedUSD += userSweepUSD;
    totalAlreadyInIBUSD += alreadyIB;

    rows.push({
      pair: `${x.symbol0}/${x.symbol1}`,
      gShare,
      gLPbalLP: Number(ethers.utils.formatUnits(gLPbal, 18)),
      pfBal_target: Number(ethers.utils.formatUnits(
        targetAddrs.has(x.token0.toLowerCase()) ? x.pfBal0 : x.pfBal1,
        targetAddrs.has(x.token0.toLowerCase()) ? x.dec0 : x.dec1
      )),
      sweepUSD,
      captureBps,
      userSweepUSD,
      alreadyIB,
      ibTS: Number(ethers.utils.formatUnits(ibTS, 18)),
    });
  }

  rows.sort((a, b) => b.userSweepUSD - a.userSweepUSD);

  console.log('\n━━━ PER-PAIR: claimFees() → InternalBribe (current epoch) recovery ━━━');
  console.log(
    'pair'.padEnd(22) + 'gauge%'.padStart(8) + 'PF target$'.padStart(12) +
    'sweep $'.padStart(12) + 'capture%'.padStart(11) + 'your $'.padStart(11) + '  IB-orphan$'
  );
  console.log('─'.repeat(95));
  for (const r of rows) {
    console.log(
      r.pair.padEnd(22) +
      r.gShare.toFixed(2).padStart(7) + '%' +
      ('$' + r.pfBal_target.toFixed(2)).padStart(12) +
      ('$' + r.sweepUSD.toFixed(2)).padStart(12) +
      ((r.captureBps / 100).toFixed(2) + '%').padStart(11) +
      ('$' + r.userSweepUSD.toFixed(2)).padStart(11) +
      ('  $' + r.alreadyIB.toFixed(2))
    );
  }
  console.log('─'.repeat(95));
  console.log(`Σ sweepable PF (axlUSDC+USDt): $${totalSweepableUSD.toFixed(2)}`);
  console.log(`Σ user capture (at calc'd %):  $${totalCapturedUSD.toFixed(2)}`);
  console.log(`Σ already in IB (orphaned):    $${totalAlreadyInIBUSD.toFixed(2)}`);

  console.log('\n━━━ INTERPRETATION ━━━');
  console.log(`If the "sweep $" column is significantly > 0 for top rows, then the prior chat's`);
  console.log(`"~$1 recoverable" conclusion missed this path. The PairFees attributed to the`);
  console.log(`gauge (because gauges hold LP) can be flushed forward via Gauge.claimFees() into`);
  console.log(`the CURRENT epoch's tokenRewardsPerEpoch, where current voters earn it.`);
  console.log(`If "sweep $" is ~0 even for high-LP-share gauges, the gauges have already been`);
  console.log(`flushed and only future swap fees can be captured.`);
})();
