/**
 * Probe feeTo and feeToSetter contracts for admin functions that would let
 * someone (a) burn the LP tokens feeTo holds, or (b) transfer them out.
 */
const { ethers } = require('ethers');
const p = new ethers.providers.StaticJsonRpcProvider({ url: 'https://api.harmony.one', timeout: 15000 });

const FEE_TO = ethers.utils.getAddress('0xd86994b247461a24943c30b544ff5d88d4b90cdc');
const FEE_TO_SETTER = ethers.utils.getAddress('0xd9fa2863b26bd3a12fbd211751dcefe041d3034f');

const probes = [
  // role getters
  'owner()', 'admin()', 'governance()', 'team()', 'pendingOwner()', 'getOwner()', 'authority()',
  // recovery / sweep
  'sweep(address)', 'sweep(address,address)', 'sweep(address,uint256)',
  'recoverERC20(address)', 'recoverERC20(address,uint256)',
  'rescue(address)', 'rescueERC20(address,uint256)',
  'withdraw(address)', 'withdraw(address,uint256)', 'withdrawERC20(address,uint256)',
  'withdrawToken(address)', 'withdrawToken(address,uint256)',
  'emergencyWithdraw(address)', 'emergencyWithdrawERC20(address,uint256)',
  // V2-style fee helpers
  'convert(address,address)', 'convert(address[])', 'convertMultiple(address[],address[])',
  'burn(address)', 'burnPair(address)', 'distribute()', 'distributeFees()',
  // ownership transfer
  'transferOwnership(address)', 'setOwner(address)', 'setAdmin(address)',
  'setFeeTo(address)', 'setFeeToSetter(address)',
  // ERC20 ops the contract can perform on tokens it holds
  'approve(address,address,uint256)', 'transfer(address,address,uint256)',
  // execute-arbitrary patterns (multisig-shaped)
  'execute(address,uint256,bytes)', 'call(address,uint256,bytes)',
  // misc
  'router()', 'factory()', 'masterChef()', 'feeToSetter()',
];

const sel = (sig) => ethers.utils.id(sig).slice(0, 10);

async function probeContract(label, addr) {
  console.log(`\n━━━ ${label}  ${addr} ━━━`);
  const code = await p.getCode(addr);
  console.log(`  bytecode size: ${(code.length - 2) / 2} bytes`);
  const lc = code.toLowerCase();
  const present = [];
  for (const sig of probes) {
    if (lc.includes(sel(sig).slice(2))) present.push(sig);
  }
  console.log(`  Selectors PRESENT (${present.length}):`);
  for (const s of present) console.log(`    ✓ ${s}  ${sel(s)}`);

  // Live values for address-shaped getters
  console.log(`  Live values:`);
  for (const sig of present) {
    if (!sig.endsWith('()')) continue;
    try {
      const c = new ethers.Contract(addr, [`function ${sig.replace('()', '() view returns (address)')}`], p);
      const fn = sig.split('(')[0];
      const v = await c[fn]();
      console.log(`    ${sig.padEnd(20)} → ${v}`);
    } catch {}
  }

  // Check transferFrom/transfer/approve opcode counts to see if contract can move tokens
  const tCount = (lc.match(/a9059cbb/g) || []).length;
  const tfCount = (lc.match(/23b872dd/g) || []).length;
  const aCount = (lc.match(/095ea7b3/g) || []).length;
  console.log(`  ERC20 op-selector occurrences: transfer=${tCount}  transferFrom=${tfCount}  approve=${aCount}`);
}

(async () => {
  await probeContract('feeTo', FEE_TO);
  await probeContract('feeToSetter', FEE_TO_SETTER);
})();
