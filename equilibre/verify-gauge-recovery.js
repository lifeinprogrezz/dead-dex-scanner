/**
 * verify-gauge-recovery.js
 *
 * Question: would Voter.createGauge(pair) on a previously-ungauged pair
 * cause the existing PairFees balance to be swept into the new InternalBribe
 * once the next epoch runs?
 *
 * Solidly fee-attribution model:
 *   - Pair._update0(amount) on swap:
 *       index0 += amount * 1e18 / totalSupply
 *       (token0 sent into PairFees)
 *   - Pair._updateFor(addr) on every LP balance change of addr:
 *       claimable0[addr] += balanceOf[addr] * (index0 - supplyIndex0[addr]) / 1e18
 *       supplyIndex0[addr] = index0
 *   - Pair.claimFees() pays out claimable0/1 of msg.sender and zeros it.
 *
 * Critical behavior: when an account first receives LP tokens, _updateFor sets
 * supplyIndex0[addr] = current index0 (with their old balance of 0, so 0 is
 * credited). They will only receive fees that accrue AFTER that point.
 *
 * Therefore a freshly-created gauge:
 *   1. Holds 0 LP at deploy time.
 *   2. When LPs stake, the gauge's supplyIndex0 jumps to current index0.
 *   3. claimable0 for the gauge starts at 0.
 *   4. Historical PairFees remain credited to the original LP holders'
 *      claimable mappings — only they can withdraw via Pair.claimFees().
 *
 * This script verifies that prediction by inspecting:
 *   - A high-volume GAUGED pair: show that its existing gauge does NOT hold
 *     all of the PairFees balance — most is already attributed to original
 *     LPs via their claimable mappings.
 *   - An UNGAUGED pair: show that PairFees holds attributable balances for
 *     the original LP holders, which a future gauge cannot reach.
 */

const { ethers } = require('ethers');
const fs = require('fs');
const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');

const VOTER = '0x4eB2B9768da9Ea26E3aBe605c9040bC12F236a59';
const ZERO = '0x0000000000000000000000000000000000000000';
const E18 = ethers.BigNumber.from(10).pow(18);

const ABI = {
  voter: ['function gauges(address) view returns (address)'],
  pair: [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fees() view returns (address)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function index0() view returns (uint256)',
    'function index1() view returns (uint256)',
    'function supplyIndex0(address) view returns (uint256)',
    'function supplyIndex1(address) view returns (uint256)',
    'function claimable0(address) view returns (uint256)',
    'function claimable1(address) view returns (uint256)',
  ],
  token: [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
  ],
};

const fmt = (raw, dec) => {
  if (!raw) return '0';
  const n = Number(ethers.utils.formatUnits(raw, dec));
  if (n === 0) return '0';
  if (n < 1e-4) return n.toExponential(3);
  if (n < 1) return n.toFixed(6);
  if (n < 1e6) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return (n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M';
};

async function readPair(pairAddr) {
  const c = new ethers.Contract(pairAddr, ABI.pair, p);
  const [t0, t1, feesAddr, sym, ts] = await Promise.all([
    c.token0(), c.token1(), c.fees(), c.symbol(), c.totalSupply(),
  ]);
  return { c, t0, t1, feesAddr, sym, ts };
}

async function readToken(addr) {
  const c = new ethers.Contract(addr, ABI.token, p);
  const [sym, dec] = await Promise.all([c.symbol(), c.decimals()]);
  return { c, sym, dec };
}

// Scan recent Transfer events to find LP-token holders.
// Kava: ~6.5s blocks → 1 day ≈ 13_300 blocks. Use 500k blocks (~ 5 weeks).
async function findHolders(pairAddr, blockTo, lookback = 500_000, chunk = 8000) {
  const iface = new ethers.utils.Interface([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  const topic = iface.getEventTopic('Transfer');
  const fromBlock = Math.max(0, blockTo - lookback);
  const holders = new Set();
  let scanned = 0;
  for (let b = fromBlock; b <= blockTo; b += chunk) {
    const end = Math.min(b + chunk - 1, blockTo);
    try {
      const logs = await p.getLogs({ address: pairAddr, topics: [topic], fromBlock: b, toBlock: end });
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        const { from, to } = parsed.args;
        if (from !== ZERO) holders.add(from.toLowerCase());
        if (to !== ZERO) holders.add(to.toLowerCase());
      }
      scanned += end - b + 1;
    } catch (e) {
      // node refused range, halve chunk
      if (chunk > 1000) {
        chunk = Math.floor(chunk / 2);
        b -= 1; // retry the same starting block on next iter
        continue;
      }
    }
  }
  return { holders: [...holders], scanned };
}

async function analyzePair(label, pairAddr) {
  console.log(`\n━━━ ${label}\n   pair ${pairAddr} ━━━`);

  const voter = new ethers.Contract(VOTER, ABI.voter, p);
  const gaugeAddr = await voter.gauges(pairAddr);
  const isG = gaugeAddr !== ZERO;
  console.log(`  Gauge: ${isG ? gaugeAddr : '(NONE — ungauged)'}`);

  const { c: pairC, t0, t1, feesAddr, sym, ts } = await readPair(pairAddr);
  const tk0 = await readToken(t0);
  const tk1 = await readToken(t1);
  console.log(`  ${sym}   totalSupply: ${fmt(ts, 18)} LP`);

  const [pf0, pf1] = await Promise.all([
    tk0.c.balanceOf(feesAddr),
    tk1.c.balanceOf(feesAddr),
  ]);
  console.log(`  PairFees stuck: ${fmt(pf0, tk0.dec)} ${tk0.sym}  /  ${fmt(pf1, tk1.dec)} ${tk1.sym}`);

  const [idx0, idx1] = await Promise.all([pairC.index0(), pairC.index1()]);

  // Sanity: cumulative-credited per index * totalSupply should match PairFees balance
  // (modulo rounding & whatever has already been claimed).
  // Implied total ever credited to LPs via index0: idx0 * totalSupply / 1e18
  const impliedCredit0 = idx0.mul(ts).div(E18);
  const impliedCredit1 = idx1.mul(ts).div(E18);
  console.log(`  Cumulative fee accrual implied by index*totalSupply:`);
  console.log(`    ${fmt(impliedCredit0, tk0.dec)} ${tk0.sym}  /  ${fmt(impliedCredit1, tk1.dec)} ${tk1.sym}`);
  console.log(`  (PairFees balance ≤ this number; the rest was already claimed historically)`);

  // What the gauge could pull on next claimFees
  if (isG) {
    const [gBal, gC0, gC1, gSI0, gSI1] = await Promise.all([
      pairC.balanceOf(gaugeAddr),
      pairC.claimable0(gaugeAddr),
      pairC.claimable1(gaugeAddr),
      pairC.supplyIndex0(gaugeAddr),
      pairC.supplyIndex1(gaugeAddr),
    ]);
    const gPct = ts.gt(0) ? gBal.mul(10000).div(ts).toNumber() / 100 : 0;
    const lag0 = idx0.sub(gSI0).mul(gBal).div(E18);
    const lag1 = idx1.sub(gSI1).mul(gBal).div(E18);
    console.log(`\n  Gauge LP balance: ${fmt(gBal, 18)} LP (${gPct}% of supply)`);
    console.log(`  Gauge claimable (already credited):  ${fmt(gC0, tk0.dec)} ${tk0.sym}  /  ${fmt(gC1, tk1.dec)} ${tk1.sym}`);
    console.log(`  Gauge lag-pending (uncredited swap fees attributable to gauge):`);
    console.log(`    ${fmt(lag0, tk0.dec)} ${tk0.sym}  /  ${fmt(lag1, tk1.dec)} ${tk1.sym}`);
    const total0 = gC0.add(lag0);
    const total1 = gC1.add(lag1);
    console.log(`  → gauge would sweep on next claimFees: ${fmt(total0, tk0.dec)} ${tk0.sym}  /  ${fmt(total1, tk1.dec)} ${tk1.sym}`);
    if (pf0.gt(0)) {
      const swept0Pct = total0.mul(10000).div(pf0).toNumber() / 100;
      console.log(`  → that's ${swept0Pct}% of the stuck ${tk0.sym} balance`);
    }
    console.log(`  → remainder is owed to OTHER LP holders via their claimable mappings`);
  }

  // Sample LP holders from recent transfer logs
  console.log(`\n  Scanning Transfer logs for LP holders…`);
  const blockNow = await p.getBlockNumber();
  const { holders, scanned } = await findHolders(pairAddr, blockNow, 500_000);
  console.log(`  Scanned ~${scanned} blocks; found ${holders.length} unique addresses.`);

  // Read each holder's current balance + claimable + supplyIndex
  const sample = holders.slice(0, 50);
  const rows = (await Promise.all(sample.map(async (h) => {
    try {
      const [bal, c0, c1, sI0, sI1] = await Promise.all([
        pairC.balanceOf(h),
        pairC.claimable0(h),
        pairC.claimable1(h),
        pairC.supplyIndex0(h),
        pairC.supplyIndex1(h),
      ]);
      return { h, bal, c0, c1, sI0, sI1 };
    } catch { return null; }
  }))).filter(r => r && (!r.bal.isZero() || !r.c0.isZero() || !r.c1.isZero()));

  let sumPending0 = ethers.BigNumber.from(0);
  let sumPending1 = ethers.BigNumber.from(0);
  for (const r of rows) {
    sumPending0 = sumPending0.add(r.c0).add(idx0.sub(r.sI0).mul(r.bal).div(E18));
    sumPending1 = sumPending1.add(r.c1).add(idx1.sub(r.sI1).mul(r.bal).div(E18));
  }
  console.log(`  Sampled ${rows.length} holders with non-zero state.`);
  console.log(`  Σ pending across sampled holders: ${fmt(sumPending0, tk0.dec)} ${tk0.sym}  /  ${fmt(sumPending1, tk1.dec)} ${tk1.sym}`);
  if (pf0.gt(0)) {
    const ratio0 = sumPending0.mul(10000).div(pf0).toNumber() / 100;
    console.log(`    = ${ratio0}% of the stuck ${tk0.sym} balance`);
  }

  // Top 5 holders by pending (descending)
  const ranked = rows
    .map(r => ({
      h: r.h,
      pend0: r.c0.add(idx0.sub(r.sI0).mul(r.bal).div(E18)),
      pend1: r.c1.add(idx1.sub(r.sI1).mul(r.bal).div(E18)),
      bal: r.bal,
    }))
    .sort((a, b) => (b.pend0.gt(a.pend0) ? 1 : -1))
    .slice(0, 5);
  console.log(`  Top sampled holders by pending ${tk0.sym}:`);
  for (const r of ranked) {
    console.log(`    ${r.h}  bal=${fmt(r.bal, 18)} LP  pend=${fmt(r.pend0, tk0.dec)} ${tk0.sym} / ${fmt(r.pend1, tk1.dec)} ${tk1.sym}`);
  }
}

(async () => {
  const data = JSON.parse(fs.readFileSync('scan-results.json', 'utf8'));
  const pairs = data.pairs;

  const isGauged = (x) => x.gauge && x.gauge !== ZERO;
  const fee0 = (x) => BigInt(x.pfBal0 || '0');
  const cmp = (a, b) => (fee0(b) > fee0(a) ? 1 : fee0(b) < fee0(a) ? -1 : 0);

  // Pick the highest-pf0 gauged pair AND highest-pf0 ungauged pair
  const gauged = pairs.filter(x => isGauged(x) && fee0(x) > 0n).sort(cmp).slice(0, 2);
  const ungauged = pairs.filter(x => !isGauged(x) && fee0(x) > 0n).sort(cmp).slice(0, 1);

  console.log(`Loaded ${pairs.length} pairs. Selected:`);
  for (const x of gauged) console.log(`  GAUGED   ${x.symbol0}/${x.symbol1}  pf0=${x.pfBal0}`);
  for (const x of ungauged) console.log(`  UNGAUGED ${x.symbol0}/${x.symbol1}  pf0=${x.pfBal0}`);

  for (const x of gauged) await analyzePair(`GAUGED  ${x.symbol0}/${x.symbol1} ${x.stable ? '(s)' : '(v)'}`, x.pair);
  for (const x of ungauged) await analyzePair(`UNGAUGED  ${x.symbol0}/${x.symbol1} ${x.stable ? '(s)' : '(v)'}`, x.pair);

  console.log(`\n━━━ INTERPRETATION ━━━`);
  console.log(`If, on a gauged pair, the gauge's "would sweep on next claimFees" amount is`);
  console.log(`significantly LESS than PairFees, the rest is locked behind individual LP`);
  console.log(`claimable mappings. createGauge() on a fresh pair cannot pull those —`);
  console.log(`the new gauge starts with supplyIndex == current index, so its claimable for`);
  console.log(`prior fees is zero by construction.`);
})();
