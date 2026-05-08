const { ethers } = require('ethers');
const fs = require('fs');

const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');
const scan = JSON.parse(fs.readFileSync('scan-results.json'));

const target = scan.pairs.find(pp =>
  pp.symbol0 === 'axlUSDC' &&
  pp.symbol1 === 'USDC' &&
  pp.gauge !== '0x0000000000000000000000000000000000000000'
);

console.log('Target pair  :', target.symbol0 + '/' + target.symbol1);
console.log('InternalBribe:', target.internalBribe);
console.log('Token0 addr  :', target.token0);

const ibAbi = [
  'function tokenRewardsPerEpoch(address,uint256) view returns (uint256)',
  'function periodFinish(address) view returns (uint256)',
  'function left(address) view returns (uint256)'
];
const erc20Abi = ['function balanceOf(address) view returns (uint256)'];

const ib = new ethers.Contract(target.internalBribe, ibAbi, p);
const erc20 = new ethers.Contract(target.token0, erc20Abi, p);

(async () => {
  const DURATION = 7 * 24 * 3600;
  const now = Math.floor(Date.now() / 1000);
  const currentEpoch = Math.floor(now / DURATION) * DURATION;

  console.log('\nCurrent epoch start :', new Date(currentEpoch * 1000).toISOString());

  const periodFinish = await ib.periodFinish(target.token0);
  const periodFinishStr = periodFinish.isZero()
    ? '(never notified)'
    : new Date(periodFinish.toNumber() * 1000).toISOString();
  console.log('periodFinish        :', periodFinish.toString(), periodFinishStr);

  const left = await ib.left(target.token0);
  const leftFmt = ethers.utils.formatUnits(left, target.dec0);
  console.log('left() (this epoch) :', leftFmt, target.symbol0);

  console.log('\ntokenRewardsPerEpoch for token0 over last 12 weeks:');
  let foundAny = false;
  let totalInEpochs = ethers.BigNumber.from(0);
  for (let i = 0; i < 12; i++) {
    const epochStart = currentEpoch - i * DURATION;
    const rewards = await ib.tokenRewardsPerEpoch(target.token0, epochStart);
    if (rewards.gt(0)) {
      foundAny = true;
      totalInEpochs = totalInEpochs.add(rewards);
      const date = new Date(epochStart * 1000).toISOString().slice(0, 10);
      console.log('  ', date, ':', ethers.utils.formatUnits(rewards, target.dec0), target.symbol0);
    }
  }
  if (!foundAny) console.log('  (no rewards notified in last 12 weeks)');
  console.log('Sum of last 12 weeks:', ethers.utils.formatUnits(totalInEpochs, target.dec0), target.symbol0);

  const totalBal = await erc20.balanceOf(target.internalBribe);
  console.log('\nTotal token0 in InternalBribe:', ethers.utils.formatUnits(totalBal, target.dec0), target.symbol0);

  const orphaned = totalBal.sub(totalInEpochs);
  console.log('Orphaned (balance - last 12 epochs):', ethers.utils.formatUnits(orphaned, target.dec0), target.symbol0);
})();
