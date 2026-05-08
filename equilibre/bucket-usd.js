const { ethers } = require('ethers');
const fs = require('fs');
const https = require('https');

const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');
const scan = JSON.parse(fs.readFileSync('scan-results.json'));

const targetAddrs = [
  '0xeb466342c4d449bc9f53a865d5cb90586f405215',  // axlUSDC
  '0x919c1c267bc06a7039e03fcc2ef738525769109c',  // USDt native
].map(a => a.toLowerCase());

// Pass voter's veNFT id via env: VENFT_ID=12345 node bucket-usd.js
const VENFT_ID = process.env.VENFT_ID;
if (!VENFT_ID) { console.error('Set VENFT_ID env var.'); process.exit(1); }
const VOTING_ESCROW = '0x35361C9c2a324F5FB8f3aed2d7bA91CE1410893A';
const PRICES = { axlUSDC: 1.0, USDt: 1.0 };

const candidates = scan.pairs.filter(pp => {
  const hasGauge = pp.gauge && pp.gauge !== '0x0000000000000000000000000000000000000000';
  const hasTargetToken = targetAddrs.includes(pp.token0.toLowerCase()) || targetAddrs.includes(pp.token1.toLowerCase());
  const hasFees = pp.pfBal0 !== '0' || pp.pfBal1 !== '0' || pp.ibBal0 !== '0' || pp.ibBal1 !== '0';
  return hasGauge && hasTargetToken && hasFees;
});

const bribeAbi = ['function totalSupply() view returns (uint256)'];
const ibAbi = ['function balanceOf(address) view returns (uint256)'];
const tokenAbi = ['function balanceOf(address) view returns (uint256)','function decimals() view returns (uint8)'];

(async () => {
  const ve = new ethers.Contract(VOTING_ESCROW, ['function balanceOfNFT(uint256) view returns (uint256)'], p);
  const YOUR_VP = await ve.balanceOfNFT(VENFT_ID);
  console.log(`Voter VP for VENFT_ID=${VENFT_ID}: ${ethers.utils.formatUnits(YOUR_VP, 18)}\n`);

  const results = [];
  for (const pp of candidates) {
    const ib = new ethers.Contract(pp.internalBribe, bribeAbi, p);
    const staleVP = await ib.totalSupply();
    const denom = staleVP.add(YOUR_VP);
    const capturePct = Number(YOUR_VP.mul(10000).div(denom)) / 100;

    // Calculate $ value of target tokens in PairFees + InternalBribe
    let targetUSD = 0;
    const checkSide = (tokenAddr, sym, dec, pfBal, ibBal) => {
      if (!targetAddrs.includes(tokenAddr.toLowerCase())) return;
      const totalRaw = ethers.BigNumber.from(pfBal).add(ethers.BigNumber.from(ibBal));
      const amount = Number(ethers.utils.formatUnits(totalRaw, dec));
      const usd = amount * (sym === 'axlUSDC' ? 1.0 : 1.0);
      targetUSD += usd;
    };
    checkSide(pp.token0, pp.symbol0, pp.dec0, pp.pfBal0, pp.ibBal0);
    checkSide(pp.token1, pp.symbol1, pp.dec1, pp.pfBal1, pp.ibBal1);

    results.push({
      pair: `${pp.symbol0}/${pp.symbol1}`,
      capturePct,
      targetUSD,
      expectedUSD: targetUSD * capturePct / 100,
      staleVP: Number(ethers.utils.formatUnits(staleVP, 18)),
    });
  }

  results.sort((a, b) => b.expectedUSD - a.expectedUSD);

  console.log('\n━━━ EXPECTED $ BY PAIR (sorted by your expected capture in $) ━━━\n');
  console.log('Pair'.padEnd(25) + 'Fees $'.padStart(12) + 'Capture %'.padStart(12) + 'Expected $'.padStart(14) + '  Bucket');
  console.log('─'.repeat(80));
  let totalExpected = 0, totalPossible = 0;
  for (const r of results) {
    const bucket = r.capturePct >= 99 ? '1-solo' : r.capturePct >= 70 ? '2-mild' : '3-heavy';
    console.log(
      r.pair.padEnd(25) +
      ('$' + r.targetUSD.toFixed(2)).padStart(12) +
      (r.capturePct.toFixed(2) + '%').padStart(12) +
      ('$' + r.expectedUSD.toFixed(2)).padStart(14) +
      '  ' + bucket
    );
    totalExpected += r.expectedUSD;
    totalPossible += r.targetUSD;
  }
  console.log('─'.repeat(80));
  console.log(`Total fees in target tokens:    $${totalPossible.toFixed(2)}`);
  console.log(`Your expected capture (all 24): $${totalExpected.toFixed(2)}`);
  const bucket12 = results.filter(r => r.capturePct >= 70);
  const b12Expected = bucket12.reduce((s, r) => s + r.expectedUSD, 0);
  const b12Possible = bucket12.reduce((s, r) => s + r.targetUSD, 0);
  console.log(`\nBuckets 1+2 only (skip the 2 bad pairs):`);
  console.log(`  Pairs:                 ${bucket12.length}`);
  console.log(`  Total fees available:  $${b12Possible.toFixed(2)}`);
  console.log(`  Your expected capture: $${b12Expected.toFixed(2)}`);
})();
