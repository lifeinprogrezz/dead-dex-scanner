/**
 * probe-factory.js
 * Quick state probe of Hermes Swap factory on Harmony.
 */
const { ethers } = require('ethers');

const RPCS = [
  process.env.RPC,
  'https://api.harmony.one',
  'https://api.s0.t.hmny.io',
  'https://harmony-mainnet.chainstacklabs.com',
  'https://1rpc.io/one',
].filter(Boolean);

const FACTORY = ethers.utils.getAddress('0xfe5e54a8e28534fffe89b9cfddfd18d3a90b42ca');

const ABI = [
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
];

async function pickProvider() {
  for (const url of RPCS) {
    try {
      const p = new ethers.providers.StaticJsonRpcProvider({ url, timeout: 10000 });
      const bn = await Promise.race([p.getBlockNumber(), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 8000))]);
      console.log(`✓ ${url}  @ block ${bn}`);
      return p;
    } catch (e) {
      console.log(`✗ ${url}  ${e.message.slice(0, 50)}`);
    }
  }
  throw new Error('no rpc');
}

(async () => {
  const p = await pickProvider();
  const f = new ethers.Contract(FACTORY, ABI, p);
  const [feeTo, setter, len] = await Promise.all([
    f.feeTo().catch(e => `REVERT: ${e.reason || e.message.slice(0, 60)}`),
    f.feeToSetter().catch(e => `REVERT: ${e.reason || e.message.slice(0, 60)}`),
    f.allPairsLength().catch(e => `REVERT: ${e.reason || e.message.slice(0, 60)}`),
  ]);
  console.log(`\nFactory:        ${FACTORY}`);
  console.log(`feeTo():        ${feeTo}`);
  console.log(`feeToSetter():  ${setter}`);
  console.log(`allPairsLength: ${len}`);

  const code = await p.getCode(FACTORY);
  console.log(`bytecode size:  ${(code.length - 2) / 2} bytes`);
})();
