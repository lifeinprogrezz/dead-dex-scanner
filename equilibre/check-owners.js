const { ethers } = require('ethers');
const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');
const ABI = ['function owner() view returns (address)'];
const targets = {
  PairFactory:  '0xA138FAFc30f6Ec6980aAd22656F2F11C38B56a95',
  BribeFactory: '0x7B14b7288D50810a6982149B107238065AA7fcb7',
  GaugeFactory: '0xa337E9426d080970b026caFfb4a83D185b85A124',
};
(async () => {
  for (const [name, addr] of Object.entries(targets)) {
    try {
      const c = new ethers.Contract(addr, ABI, p);
      const owner = await c.owner();
      console.log(`${name.padEnd(14)} owner = ${owner}`);
    } catch (e) {
      console.log(`${name.padEnd(14)} REVERTED: ${e.reason || e.message.slice(0,80)}`);
    }
  }
})();
