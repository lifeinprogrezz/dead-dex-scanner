const { ethers } = require('ethers');
const https = require('https');

const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');

const tokens = {
  'USDt (suspect)':   '0xb44a9b6905af7c801311e8f4e76932ee959c663c',  // multichain address
  'LION':             null,  // will find from scan
  'TIGER':            null,
};

const fs = require('fs');
const scan = JSON.parse(fs.readFileSync('scan-results.json'));

// Find actual addresses from scan
for (const pair of scan.pairs) {
  if (pair.symbol0 === 'USDt' && !tokens['USDt (actual)']) tokens['USDt (actual)'] = pair.token0;
  if (pair.symbol1 === 'USDt' && !tokens['USDt (actual)']) tokens['USDt (actual)'] = pair.token1;
  if (pair.symbol0 === 'LION' && !tokens['LION']) tokens['LION'] = pair.token0;
  if (pair.symbol1 === 'LION' && !tokens['LION']) tokens['LION'] = pair.token1;
  if (pair.symbol0 === 'TIGER' && !tokens['TIGER']) tokens['TIGER'] = pair.token0;
  if (pair.symbol1 === 'TIGER' && !tokens['TIGER']) tokens['TIGER'] = pair.token1;
}

console.log('Token addresses:');
for (const [label, addr] of Object.entries(tokens)) {
  console.log(`  ${label.padEnd(20)} ${addr}`);
}

function fetchDex(addr) {
  return new Promise((resolve) => {
    https.get(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  console.log('\n━━━ DEEP DIVE ON SUSPICIOUS VALUES ━━━\n');

  for (const [label, addr] of Object.entries(tokens)) {
    if (!addr) continue;
    console.log(`\n─── ${label}  (${addr}) ───`);
    const data = await fetchDex(addr);
    if (!data || !data.pairs?.length) { console.log('  No DexScreener data'); continue; }
    const kava = data.pairs.filter(pp => pp.chainId === 'kava');
    console.log(`  Pairs on Kava: ${kava.length} (across all DEXes)`);
    for (const pr of kava.slice(0, 5)) {
      console.log(`    ${pr.dexId.padEnd(14)} ${pr.baseToken.symbol}/${pr.quoteToken.symbol}`);
      console.log(`      price:     $${parseFloat(pr.priceUsd || 0).toFixed(8)}`);
      console.log(`      liquidity: $${(pr.liquidity?.usd || 0).toFixed(0)}`);
      console.log(`      24h vol:   $${(pr.volume?.h24 || 0).toFixed(0)}`);
      console.log(`      24h txns:  ${(pr.txns?.h24?.buys || 0) + (pr.txns?.h24?.sells || 0)}`);
    }
  }
})();
