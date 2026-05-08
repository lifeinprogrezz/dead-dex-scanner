/**
 * Extract every 4-byte function selector from a contract's dispatcher.
 * Solidity dispatcher pattern: PUSH4 <selector> EQ PUSH2 <jump> JUMPI
 * Hex: 63 XXXXXXXX 14 61 YYYY 57
 */
const { ethers } = require('ethers');
const p = new ethers.providers.StaticJsonRpcProvider({ url: 'https://api.harmony.one', timeout: 15000 });

const ADDR = process.argv[2] || '0xd86994b247461a24943c30b544ff5d88d4b90cdc';
const KNOWN_SIGS = [
  // Common ERC20
  'totalSupply()', 'balanceOf(address)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)', 'approve(address,uint256)', 'allowance(address,address)', 'name()', 'symbol()', 'decimals()',
  // Ownable
  'owner()', 'transferOwnership(address)', 'renounceOwnership()',
  // SushiMaker / fee-converter pattern
  'convert(address,address)', 'convertMultiple(address[],address[])',
  'bridgeFor(address)', 'setBridge(address,address)', 'bridges(address)',
  // Generic admin
  'admin()', 'governance()', 'team()', 'pauser()', 'pause()', 'unpause()', 'paused()',
  'setOwner(address)', 'setAdmin(address)',
  // Recovery
  'sweep(address)', 'sweep(address,address)', 'sweep(address,uint256)',
  'recoverERC20(address)', 'recoverERC20(address,uint256)',
  'rescue(address,address,uint256)', 'rescueERC20(address,address,uint256)',
  'withdraw(address)', 'withdrawERC20(address,uint256)', 'withdrawToken(address,uint256)',
  'inCaseTokensGetStuck(address,uint256)', 'inCaseTokensGetStuck(address)',
  // Hermes-specific guesses
  'router()', 'factory()', 'masterChef()', 'feeToSetter()',
  'distribute()', 'distributeFees()', 'collect()', 'process()', 'processAll()',
  'burn(address)', 'burnPair(address)',
  'execute(address,uint256,bytes)', 'multicall(bytes[])',
];

const known = {};
for (const sig of KNOWN_SIGS) known[ethers.utils.id(sig).slice(0, 10)] = sig;

(async () => {
  const code = (await p.getCode(ADDR)).toLowerCase();
  console.log(`Contract: ${ADDR}`);
  console.log(`Bytecode size: ${(code.length - 2) / 2} bytes\n`);

  // Pattern: 63 XX XX XX XX (PUSH4 selector). Find all unique selectors.
  const matches = code.match(/63[0-9a-f]{8}/g) || [];
  const uniq = new Set();
  for (const m of matches) uniq.add('0x' + m.slice(2));

  console.log(`Found ${uniq.size} candidate selectors in bytecode:\n`);
  // Print sorted; mark known ones
  const sorted = [...uniq].sort();
  for (const s of sorted) {
    const sig = known[s];
    console.log(`  ${s}  ${sig ? '✓ ' + sig : ''}`);
  }
})();
