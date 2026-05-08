const { ethers } = require('ethers');
const https = require('https');

const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');

const targets = {
  PairFactory:  '0xA138FAFc30f6Ec6980aAd22656F2F11C38B56a95',
  BribeFactory: '0x7B14b7288D50810a6982149B107238065AA7fcb7',
  GaugeFactory: '0xa337E9426d080970b026caFfb4a83D185b85A124',
};

function extractSelectors(bytecode) {
  const selectors = new Set();
  const regex = /63([0-9a-f]{8})/gi;
  let match;
  while ((match = regex.exec(bytecode)) !== null) {
    selectors.add('0x' + match[1].toLowerCase());
  }
  return [...selectors];
}

function lookupSelector(sel) {
  return new Promise((resolve) => {
    const url = `https://api.openchain.xyz/signature-database/v1/lookup?function=${sel}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const sigs = j.result?.function?.[sel];
          resolve(sigs?.[0]?.name || '(unknown)');
        } catch (e) {
          resolve('(lookup failed)');
        }
      });
    }).on('error', () => resolve('(network error)'));
  });
}

(async () => {
  for (const [name, addr] of Object.entries(targets)) {
    console.log(`\n━━━ ${name} ━━━`);
    const code = await p.getCode(addr);
    const selectors = extractSelectors(code);
    console.log(`Found ${selectors.length} selectors. Resolving...\n`);

    const results = [];
    for (const sel of selectors) {
      const sig = await lookupSelector(sel);
      results.push({ selector: sel, signature: sig });
      await new Promise((r) => setTimeout(r, 100));
    }

    results.sort((a, b) => {
      const aUnknown = a.signature.startsWith('(');
      const bUnknown = b.signature.startsWith('(');
      if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
      return a.signature.localeCompare(b.signature);
    });

    results.forEach(r => console.log(`  ${r.selector}  ${r.signature}`));
  }
})();
