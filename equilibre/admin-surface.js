const { ethers } = require('ethers');
const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');

const targets = {
  Voter:        '0x4eB2B9768da9Ea26E3aBe605c9040bC12F236a59',
  VotingEscrow: '0x35361C9c2a324F5FB8f3aed2d7bA91CE1410893A',
  Minter:       '0x46a88F88584c9d4751dB36DA9127F12E4DCAD6B8',
};

// Common Solidly-fork admin functions worth probing.
// Selector = first 4 bytes of keccak256(signature).
const probes = [
  // role getters
  'owner()',
  'admin()',
  'governor()',
  'emergencyCouncil()',
  'team()',
  'pendingTeam()',
  'pendingGovernor()',
  'pauser()',
  'feeManager()',
  'minter()',
  'voter()',

  // Voter admin actions
  'setGovernor(address)',
  'setEmergencyCouncil(address)',
  'whitelist(address)',
  'killGauge(address)',
  'reviveGauge(address)',
  'createGauge(address)',
  'setMaxVotingNum(uint256)',

  // Minter admin actions
  'setTeam(address)',
  'acceptTeam()',
  'setTeamRate(uint256)',
  'initialize(address[],uint256[],uint256)',

  // Recovery-style functions worth checking explicitly
  'recoverERC20(address,uint256)',
  'sweep(address)',
  'sweep(address,address)',
  'rescue(address,address,uint256)',
  'rescueERC20(address,address,uint256)',
  'withdrawERC20(address,uint256)',
];

const sel = (sig) => ethers.utils.id(sig).slice(0, 10);

(async () => {
  for (const [name, addr] of Object.entries(targets)) {
    console.log(`\n━━━ ${name}  (${addr}) ━━━`);
    const code = await p.getCode(addr);
    const present = [];
    const callable = [];
    for (const sig of probes) {
      const s = sel(sig).slice(2); // strip 0x
      if (code.toLowerCase().includes(s)) {
        present.push(sig);
        // try to call view-style functions (no args, returns address)
        if (sig.endsWith('()')) {
          try {
            const c = new ethers.Contract(addr, [`function ${sig.replace('()', '() view returns (address)')}`], p);
            const fn = sig.split('(')[0];
            const v = await c[fn]();
            callable.push(`${sig.padEnd(28)} → ${v}`);
          } catch (e) {
            // not address-returning; ignore
          }
        }
      }
    }
    console.log(`  Selectors found in bytecode (${present.length}):`);
    present.forEach(s => console.log(`    • ${s}`));
    if (callable.length) {
      console.log(`  Address-returning views:`);
      callable.forEach(s => console.log(`    ${s}`));
    }
  }
})();
