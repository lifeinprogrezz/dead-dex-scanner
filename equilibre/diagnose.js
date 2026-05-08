const { ethers } = require('ethers');
const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');

const targets = {
  PairFactory:  '0xA138FAFc30f6Ec6980aAd22656F2F11C38B56a95',
  BribeFactory: '0x7B14b7288D50810a6982149B107238065AA7fcb7',
  GaugeFactory: '0xa337E9426d080970b026caFfb4a83D185b85A124',
};

// EIP-1967 storage slots
const IMPL_SLOT  = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// Common admin-style functions to probe
const probes = [
  { sig: 'owner()',          abi: ['function owner() view returns (address)'] },
  { sig: 'admin()',          abi: ['function admin() view returns (address)'] },
  { sig: 'governance()',     abi: ['function governance() view returns (address)'] },
  { sig: 'team()',           abi: ['function team() view returns (address)'] },
  { sig: 'pendingOwner()',   abi: ['function pendingOwner() view returns (address)'] },
  { sig: 'getAdmin()',       abi: ['function getAdmin() view returns (address)'] },
];

const slotToAddr = (hex) => {
  if (!hex || hex === '0x' || /^0x0+$/.test(hex)) return null;
  return ethers.utils.getAddress('0x' + hex.slice(-40));
};

(async () => {
  for (const [name, addr] of Object.entries(targets)) {
    console.log(`\n━━━ ${name}  (${addr}) ━━━`);

    // 1. Is this an EIP-1967 proxy?
    const implRaw  = await p.getStorageAt(addr, IMPL_SLOT);
    const adminRaw = await p.getStorageAt(addr, ADMIN_SLOT);
    const impl  = slotToAddr(implRaw);
    const admin = slotToAddr(adminRaw);

    if (impl) {
      console.log(`  EIP-1967 IMPL  : ${impl}`);
      console.log(`  EIP-1967 ADMIN : ${admin || '(not set — implies Ownable pattern on impl)'}`);
    } else {
      console.log(`  Not an EIP-1967 proxy (no impl slot)`);
    }

    // 2. Probe admin-style functions
    for (const { sig, abi } of probes) {
      try {
        const c = new ethers.Contract(addr, abi, p);
        const fn = sig.split('(')[0];
        const val = await c[fn]();
        console.log(`  ${sig.padEnd(20)} → ${val}`);
      } catch (e) {
        // silent — only print successes
      }
    }

    // 3. Read bytecode size (0 = EOA / not deployed)
    const code = await p.getCode(addr);
    console.log(`  bytecode size  : ${(code.length - 2) / 2} bytes`);
  }
})();
