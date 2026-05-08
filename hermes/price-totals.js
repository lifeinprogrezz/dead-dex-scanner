/**
 * Aggregate the underlying-token amounts that feeTo would receive if its
 * LP positions were burned, then look up USD prices on DexScreener
 * (Harmony chain) to compute the recoverable dollar value.
 */
const fs = require('fs');
const https = require('https');
const { ethers } = require('ethers');

const data = JSON.parse(fs.readFileSync('hermes-scan.json', 'utf8'));

// Aggregate raw owed amounts per token
const agg = new Map();
for (const r of data.pairs) {
  const add = (addr, sym, dec, raw) => {
    if (raw === '0') return;
    const k = addr.toLowerCase();
    const c = agg.get(k) || { sym, dec, raw: ethers.BigNumber.from(0) };
    c.raw = c.raw.add(raw);
    agg.set(k, c);
  };
  add(r.t0, r.symbol0, r.dec0, r.owed0);
  add(r.t1, r.symbol1, r.dec1, r.owed1);
}

function fetchPrice(addr) {
  return new Promise((resolve) => {
    https.get(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const all = j.pairs || [];
          const harmony = all.filter(x => x.chainId === 'harmony');
          const best = (harmony.length ? harmony : all).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
          resolve({
            price: best ? parseFloat(best.priceUsd || 0) : 0,
            liq: best?.liquidity?.usd || 0,
            chain: best?.chainId || 'n/a',
            dex: best?.dexId || 'n/a',
          });
        } catch { resolve({ price: 0, liq: 0, chain: 'err' }); }
      });
    }).on('error', () => resolve({ price: 0, liq: 0, chain: 'err' }));
  });
}

(async () => {
  console.log(`Pricing ${agg.size} unique tokens via DexScreener...\n`);
  const rows = [];
  let i = 0;
  for (const [addr, d] of agg.entries()) {
    i++;
    process.stdout.write(`\r  ${i}/${agg.size}`);
    const pr = await fetchPrice(addr);
    const amt = Number(ethers.utils.formatUnits(d.raw, d.dec));
    rows.push({ addr, sym: d.sym, amount: amt, price: pr.price, liq: pr.liq, chain: pr.chain, dex: pr.dex, usd: amt * pr.price });
    await new Promise(r => setTimeout(r, 250));
  }
  console.log('\n');

  rows.sort((a, b) => b.usd - a.usd);
  let total = 0, deadDepeg = 0;
  // 1USDC, 1ETH, 1WBTC, 1DAI, 1BTC are Horizon-bridge-exploit tokens (June 2022)
  const HORIZON_PREFIXES = ['1USDC', '1USDT', '1ETH', '1WBTC', '1DAI', '1BTC', '1AAVE', '1SUSHI', '1WETH'];
  console.log('Symbol'.padEnd(10) + 'Amount'.padStart(20) + 'Price$'.padStart(15) + 'Liquidity$'.padStart(15) + 'USD value'.padStart(14) + '  source');
  console.log('─'.repeat(95));
  for (const r of rows) {
    const isHorizon = HORIZON_PREFIXES.some(p => r.sym === p);
    const tag = isHorizon ? '☠ Horizon (likely depegged)' : (r.liq > 5000 ? '✓ liquid' : r.liq > 100 ? '~ low-liq' : '? illiquid');
    console.log(
      r.sym.slice(0, 9).padEnd(10) +
      r.amount.toLocaleString('en-US', { maximumFractionDigits: 4 }).padStart(20) +
      ('$' + r.price.toExponential(3)).padStart(15) +
      ('$' + r.liq.toFixed(0)).padStart(15) +
      ('$' + r.usd.toFixed(4)).padStart(14) +
      `  ${tag}`
    );
    total += r.usd;
    if (isHorizon) deadDepeg += r.usd;
  }
  console.log('─'.repeat(95));
  console.log(`Σ raw USD (price × amount, no haircut): $${total.toFixed(2)}`);
  console.log(`Σ Horizon-bridge tokens (dead/depegged): $${deadDepeg.toFixed(2)}`);
  console.log(`Realistic recoverable (excl Horizon):    $${(total - deadDepeg).toFixed(2)}`);
})();
