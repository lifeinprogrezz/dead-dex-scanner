/**
 * probe-swap-out.js
 *
 * Investigate whether swapOutRewardToken on InternalBribe is a recovery
 * vector. Steps:
 *   1. Read team() of a live IB.
 *   2. Read all rewards[i] entries.
 *   3. Simulate (via eth_call from team) swapOutRewardToken(i, old, new) for
 *      a couple of plausible substitutions and check whether it reverts.
 *   4. Probe the bytecode for any token-transfer opcode patterns near the
 *      swapOutRewardToken selector to detect non-standard variants.
 */

const { ethers } = require('ethers');
const fs = require('fs');
const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');
const scan = JSON.parse(fs.readFileSync('scan-results.json'));

// Pick a high-value IB
const target = scan.pairs.find(x => x.symbol0 === 'axlUSDC' && x.symbol1 === 'USDC');
console.log(`Target IB: ${target.internalBribe} (axlUSDC/USDC pair)`);

const IB_ABI = [
  'function team() view returns (address)',
  'function voter() view returns (address)',
  'function rewards(uint256) view returns (address)',
  'function rewardsListLength() view returns (uint256)',
  'function isReward(address) view returns (bool)',
  'function swapOutRewardToken(uint256,address,address)',
];

(async () => {
  const ib = new ethers.Contract(target.internalBribe, IB_ABI, p);

  // 1. Read team
  let teamAddr;
  try {
    teamAddr = await ib.team();
    console.log(`  team() = ${teamAddr}`);
  } catch (e) {
    console.log(`  team() reverted: ${e.message.slice(0, 80)}`);
  }
  const voterAddr = await ib.voter();
  console.log(`  voter() = ${voterAddr}`);

  // 2. Rewards list
  const len = await ib.rewardsListLength();
  console.log(`  rewardsListLength = ${len.toString()}`);
  const rewardTokens = [];
  for (let i = 0; i < Number(len); i++) {
    const t = await ib.rewards(i);
    rewardTokens.push(t);
    console.log(`    [${i}] ${t}`);
  }

  // 3. Simulate swapOutRewardToken(0, rewards[0], rewards[0]) — no-op self-swap
  console.log(`\n━━━ SIMULATING swapOutRewardToken via eth_call ━━━`);
  const sender = teamAddr || '0x7cef2432A2690168Fb8eb7118A74d5f8EfF9Ef55';
  console.log(`  msg.sender (simulated): ${sender}`);

  // Build calldata
  const iface = new ethers.utils.Interface(IB_ABI);

  // Test A: self-swap (same token both sides)
  const callA = iface.encodeFunctionData('swapOutRewardToken', [0, rewardTokens[0], rewardTokens[0]]);
  try {
    const result = await p.call({ from: sender, to: target.internalBribe, data: callA });
    console.log(`  ✓ swapOutRewardToken(0, ${rewardTokens[0].slice(0, 10)}…, same) — OK, returned ${result}`);
  } catch (e) {
    console.log(`  ✗ swapOutRewardToken(0, X, X) reverted: ${e.reason || e.message.slice(0, 100)}`);
  }

  // Test B: swap to a random other token (use VARA as substitute)
  const VARA = '0xE1da44C0dA55B075aE8E2e4b6986AdC76Ac77d73';
  const callB = iface.encodeFunctionData('swapOutRewardToken', [0, rewardTokens[0], VARA]);
  try {
    const result = await p.call({ from: sender, to: target.internalBribe, data: callB });
    console.log(`  ✓ swapOutRewardToken(0, ${rewardTokens[0].slice(0, 10)}…, VARA) — OK`);
  } catch (e) {
    console.log(`  ✗ swapOutRewardToken(0, X, VARA) reverted: ${e.reason || e.message.slice(0, 100)}`);
  }

  // Test C: swap from a NON-team sender (should revert)
  const fakeSender = '0x0000000000000000000000000000000000001234';
  try {
    const result = await p.call({ from: fakeSender, to: target.internalBribe, data: callA });
    console.log(`  ! swapOutRewardToken from non-team — unexpectedly OK (selector check missing)`);
  } catch (e) {
    console.log(`  ✓ swapOutRewardToken from non-team reverts as expected: ${e.reason || e.message.slice(0, 80)}`);
  }

  // 4. Look for transfer-style opcode patterns near swapOutRewardToken in bytecode
  // Selector is 0x9418f939. Find offset and inspect ±200 bytes for SafeTransfer-like patterns.
  console.log(`\n━━━ Bytecode inspection around swapOutRewardToken ━━━`);
  const code = await p.getCode(target.internalBribe);
  const sel = '9418f939';
  const lower = code.toLowerCase();
  let offset = lower.indexOf(sel);
  while (offset !== -1) {
    console.log(`  selector found at offset ${offset / 2} bytes`);
    // Show ±100 bytes
    const start = Math.max(0, offset - 200);
    const end = Math.min(lower.length, offset + 200);
    console.log(`    context (hex): ${lower.slice(start, end)}`);
    offset = lower.indexOf(sel, offset + 1);
  }

  // Also count ERC20.transfer / transferFrom selectors in the function logic vicinity
  // ERC20.transfer = 0xa9059cbb, transferFrom = 0x23b872dd
  const transferOccurrences = (lower.match(/a9059cbb/g) || []).length;
  const transferFromOccurrences = (lower.match(/23b872dd/g) || []).length;
  console.log(`\n  Total occurrences in bytecode:`);
  console.log(`    transfer(0xa9059cbb): ${transferOccurrences}`);
  console.log(`    transferFrom(0x23b872dd): ${transferFromOccurrences}`);
  console.log(`  (For reference: standard Velo IB has 1× transferFrom in notifyRewardAmount`);
  console.log(`   and 1× transfer in getReward. swapOutRewardToken contains NO transfers in standard impl.)`);
})();
