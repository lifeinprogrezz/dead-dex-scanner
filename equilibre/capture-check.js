const { ethers } = require('ethers');
const fs = require('fs');
const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');

const scan = JSON.parse(fs.readFileSync('scan-results.json'));

// Pass voter's veNFT id via env: VENFT_ID=12345 node capture-check.js
const VENFT_ID = process.env.VENFT_ID;
if (!VENFT_ID) { console.error('Set VENFT_ID env var.'); process.exit(1); }
const VOTING_ESCROW = '0x35361C9c2a324F5FB8f3aed2d7bA91CE1410893A';

// Find gauged pairs with axlUSDC or native USDt in them (our target bucket)
const targetTokens = {
  axlUSDC:     '0xEB466342C4d449BC9f53A865D5Cb90586f405215',  // Axelar USDC on Kava
  USDt_native: '0x919C1c267BC06a7039e03fcc2eF738525769109c',  // Native USDt
};

const targetAddrs = Object.values(targetTokens).map(a => a.toLowerCase());

const candidates = scan.pairs.filter(pp => {
  const hasGauge = pp.gauge && pp.gauge !== '0x0000000000000000000000000000000000000000';
  const hasTargetToken = targetAddrs.includes(pp.token0.toLowerCase()) || targetAddrs.includes(pp.token1.toLowerCase());
  const hasFees = pp.pfBal0 !== '0' || pp.pfBal1 !== '0' || pp.ibBal0 !== '0' || pp.ibBal1 !== '0';
  return hasGauge && hasTargetToken && hasFees;
});

console.log(`Found ${candidates.length} gauged pairs with axlUSDC or native USDt AND stuck fees\n`);

const bribeAbi = ['function totalSupply() view returns (uint256)'];

(async () => {
  const ve = new ethers.Contract(VOTING_ESCROW, ['function balanceOfNFT(uint256) view returns (uint256)'], p);
  const YOUR_VP = await ve.balanceOfNFT(VENFT_ID);
  console.log(`Voter VP for VENFT_ID=${VENFT_ID}: ${ethers.utils.formatUnits(YOUR_VP, 18)}\n`);

  console.log('Pair'.padEnd(28) + 'InternalBribe totalSupply'.padEnd(28) + 'Your capture share');
  console.log('─'.repeat(85));

  let totalStaleVP = ethers.BigNumber.from(0);
  let count = 0;

  for (const pp of candidates) {
    if (!pp.internalBribe || pp.internalBribe === '0x0000000000000000000000000000000000000000') continue;
    try {
      const ib = new ethers.Contract(pp.internalBribe, bribeAbi, p);
      const ts = await ib.totalSupply();
      const denom = ts.add(YOUR_VP);  // if you vote with all your VP, denom becomes ts + yours
      const captureBps = YOUR_VP.mul(10000).div(denom);
      const tsReadable = Number(ethers.utils.formatUnits(ts, 18));
      const pct = Number(captureBps) / 100;
      console.log(
        `${pp.symbol0}/${pp.symbol1}`.padEnd(28) +
        `${tsReadable.toLocaleString('en-US',{maximumFractionDigits:0})} VP`.padEnd(28) +
        `${pct.toFixed(2)}%`
      );
      totalStaleVP = totalStaleVP.add(ts);
      count++;
    } catch (e) {
      console.log(`${pp.symbol0}/${pp.symbol1} — error: ${e.message.slice(0,40)}`);
    }
  }

  if (count > 0) {
    console.log('─'.repeat(85));
    const avgStale = totalStaleVP.div(count);
    const avgDenom = avgStale.add(YOUR_VP);
    const avgCapture = Number(YOUR_VP.mul(10000).div(avgDenom)) / 100;
    console.log(`\nAverage stale VP in target gauges: ${Number(ethers.utils.formatUnits(avgStale, 18)).toLocaleString('en-US',{maximumFractionDigits:0})}`);
    console.log(`Your expected capture rate:        ${avgCapture.toFixed(2)}%`);
    console.log(`\nAt ${avgCapture.toFixed(1)}% capture, your share of ~$4,000 = ~$${(4000 * avgCapture / 100).toFixed(0)}`);
  }
})();
