/**
 * probe-bribe-admin.js
 *
 * The previous admin-surface probe checked Voter / VotingEscrow / Minter but
 * NOT InternalBribe. Many Solidly forks expose admin-callable functions on the
 * Bribe contracts directly (swapOutRewardToken, addRewardToken,
 * recoverERC20, etc.) that the earlier scan would have missed.
 *
 * Probe a sample InternalBribe + ExternalBribe (if present) for every
 * admin-shaped selector across known forks.
 */

const { ethers } = require('ethers');
const fs = require('fs');
const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');
const scan = JSON.parse(fs.readFileSync('scan-results.json'));

const ZERO = '0x0000000000000000000000000000000000000000';

// Known IB / Bribe selectors across Velo/Solidly/Equalizer/Thena variants
const probes = [
  // role getters
  'owner()',
  'admin()',
  'governance()',
  'team()',
  'voter()',
  'gauge()',
  'minter()',
  // reward management
  'addRewardToken(address)',
  'addReward(address)',
  'removeRewardToken(uint256)',
  'removeReward(address)',
  'swapOutRewardToken(uint256,address,address)',
  'swapOutBribeRewardToken(uint256,address,address)',
  'replaceReward(address,address)',
  // recovery
  'recoverERC20(address,uint256)',
  'recoverERC20AndUpdateData(address,uint256)',
  'sweep(address)',
  'sweep(address,address)',
  'sweep(address,uint256)',
  'rescue(address)',
  'rescueERC20(address,uint256)',
  'rescueERC20(address,address,uint256)',
  'withdrawERC20(address,uint256)',
  'withdrawToken(address,uint256)',
  'withdraw(address,uint256)',
  'emergencyWithdraw(address)',
  // notification (already known to exist but verify variants)
  'notifyRewardAmount(address,uint256)',
  'notifyReward(address,uint256)',
  // earning paths
  'earned(address,uint256)',
  'earned(uint256,address)',
  'getReward(uint256,address[])',
  'getRewardForOwner(uint256,address[])',
  'getRewardForAddress(address,address[])',
  // deposit/withdraw (called by Voter)
  '_deposit(uint256,uint256)',
  '_withdraw(uint256,uint256)',
  // misc
  'rewardsListLength()',
  'rewards(uint256)',
  'isReward(address)',
  'periodFinish(address)',
  'tokenRewardsPerEpoch(address,uint256)',
  'totalSupplyAt(uint256)',
  'balanceOfAt(uint256,uint256)',
  'getEpochStart(uint256)',
];

const sel = (sig) => ethers.utils.id(sig).slice(0, 10);

(async () => {
  // pick the IB with the largest IB target balance, and one with both axlUSDC and USDC
  const sample = scan.pairs.find(x => x.symbol0 === 'axlUSDC' && x.symbol1 === 'USDC' && x.internalBribe && x.internalBribe !== ZERO);
  console.log(`Sampling InternalBribe of ${sample.symbol0}/${sample.symbol1}: ${sample.internalBribe}`);

  const code = await p.getCode(sample.internalBribe);
  console.log(`  bytecode size: ${(code.length - 2) / 2} bytes\n`);

  const present = [];
  const absent = [];
  for (const sig of probes) {
    const s = sel(sig).slice(2);
    if (code.toLowerCase().includes(s)) present.push(sig);
    else absent.push(sig);
  }

  console.log(`━━━ Selectors PRESENT (${present.length}) ━━━`);
  for (const s of present) console.log(`  ✓ ${s}  ${sel(s)}`);

  console.log(`\n━━━ Selectors ABSENT (${absent.length}) ━━━`);
  for (const s of absent) console.log(`  ✗ ${s}`);

  // For any present role-getter, call it
  console.log(`\n━━━ Live values for present role-getters ━━━`);
  for (const sig of present) {
    if (!sig.endsWith('()')) continue;
    try {
      const c = new ethers.Contract(sample.internalBribe, [`function ${sig.replace('()', '() view returns (address)')}`], p);
      const fn = sig.split('(')[0];
      const v = await c[fn]();
      console.log(`  ${sig.padEnd(20)} → ${v}`);
    } catch {
      // not address-shaped
    }
  }

  // Iterate the rewards list to learn what tokens are tracked
  console.log(`\n━━━ Rewards-list contents ━━━`);
  try {
    const c = new ethers.Contract(sample.internalBribe, [
      'function rewardsListLength() view returns (uint256)',
      'function rewards(uint256) view returns (address)',
      'function isReward(address) view returns (bool)',
    ], p);
    const len = await c.rewardsListLength();
    console.log(`  rewardsListLength = ${len.toString()}`);
    for (let i = 0; i < Math.min(Number(len), 10); i++) {
      const t = await c.rewards(i);
      const isR = await c.isReward(t);
      console.log(`    [${i}] ${t}  isReward=${isR}`);
    }
  } catch (e) {
    console.log(`  (rewardsListLength not callable: ${e.message.slice(0, 60)})`);
  }
})();
