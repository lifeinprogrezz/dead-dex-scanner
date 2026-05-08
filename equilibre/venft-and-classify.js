const { ethers } = require('ethers');
const https = require('https');
const fs = require('fs');

const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');

const VOTING_ESCROW = '0x35361C9c2a324F5FB8f3aed2d7bA91CE1410893A';

// Pass the addresses to inspect via WALLETS env var (comma-separated).
// Format: "0xaaa...,0xbbb..."  or  "label1:0xaaa...,label2:0xbbb..."
//   WALLETS=0x7cef...,0x3a72... node venft-and-classify.js
const WALLETS = (() => {
  const raw = (process.env.WALLETS || '').trim();
  if (!raw) {
    console.error('Set WALLETS env var (comma-separated addresses, optionally label:addr).');
    process.exit(1);
  }
  const out = {};
  raw.split(',').map(s => s.trim()).filter(Boolean).forEach((entry, i) => {
    const [a, b] = entry.includes(':') ? entry.split(':') : [`wallet-${i + 1}`, entry];
    out[a.trim()] = b.trim();
  });
  return out;
})();

// Known Multichain (depegged July 2023, worthless) Kava tokens.
const MULTICHAIN = new Set([
  '0xfa9343c3897324496a05fc75abed6bac29f8a40f', // anyUSDC  ("USDC")
  '0xb44a9b6905af7c801311e8f4e76932ee959c663c', // anyUSDT  ("USDt")
  '0x765277eebeca2e31912c9946eae1021199b39c61', // anyDAI   ("DAI")
  '0xe3f5a90f9cb311505cd691a46596599aa1a0ad7d', // anyETH   ("ETH")
  '0xb5c4423a65b953905949548276654c96fcae6992', // anyWBTC  ("WBTC")
].map(a => a.toLowerCase()));

const veAbi = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function locked(uint256) view returns (int128 amount, uint256 end)',
  'function supply() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOfNFT(uint256) view returns (uint256)',
];

async function checkVeNFTs() {
  console.log('━━━ VOTING ESCROW POSITIONS ━━━\n');
  const ve = new ethers.Contract(VOTING_ESCROW, veAbi, p);
  const supply = await ve.supply();
  const totalVP = await ve.totalSupply();
  console.log(`Total VARA locked (protocol):  ${Number(ethers.utils.formatUnits(supply, 18)).toLocaleString()}`);
  console.log(`Total voting power (protocol): ${Number(ethers.utils.formatUnits(totalVP, 18)).toLocaleString()}\n`);

  let myLocked = ethers.BigNumber.from(0);
  let myVP = ethers.BigNumber.from(0);

  for (const [label, addr] of Object.entries(WALLETS)) {
    try {
      const count = (await ve.balanceOf(addr)).toNumber();
      if (count === 0) { console.log(`${label.padEnd(27)} — 0 veNFTs`); continue; }
      console.log(`${label}  (${addr})`);
      console.log(`  ${count} veNFT${count > 1 ? 's' : ''}`);
      for (let i = 0; i < count; i++) {
        try {
          const id = await ve.tokenOfOwnerByIndex(addr, i);
          const { amount, end } = await ve.locked(id);
          const vp = await ve.balanceOfNFT(id);
          const lk = ethers.BigNumber.from(amount.toString());
          myLocked = myLocked.add(lk);
          myVP = myVP.add(vp);
          const unlock = new Date(end.toNumber() * 1000).toISOString().slice(0, 10);
          console.log(`    NFT#${id.toString().padStart(6)}  ${ethers.utils.formatUnits(lk, 18).padStart(14)} VARA  ·  VP ${ethers.utils.formatUnits(vp, 18).padStart(14)}  ·  unlocks ${unlock}`);
        } catch (e) { console.log(`    NFT[${i}] error: ${e.message.slice(0, 60)}`); }
      }
    } catch (e) { console.log(`${label}: failed — ${e.message.slice(0, 60)}`); }
  }

  console.log(`\n━━━ YOUR SHARE ━━━`);
  console.log(`Locked (yours):        ${Number(ethers.utils.formatUnits(myLocked, 18)).toLocaleString()} VARA`);
  console.log(`Voting power (yours):  ${Number(ethers.utils.formatUnits(myVP, 18)).toLocaleString()}`);
  if (!totalVP.isZero()) {
    const pct = Number(myVP.mul(1000000).div(totalVP)) / 10000;
    console.log(`Your % of total VP:    ${pct.toFixed(2)}%`);
  }
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
          const kava = all.filter(x => x.chainId === 'kava');
          const best = (kava.length ? kava : all).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
          resolve({ price: best ? parseFloat(best.priceUsd || 0) : 0, liq: best?.liquidity?.usd || 0, chain: best?.chainId || 'n/a' });
        } catch { resolve({ price: 0, liq: 0, chain: 'err' }); }
      });
    }).on('error', () => resolve({ price: 0, liq: 0, chain: 'err' }));
  });
}

async function classify() {
  console.log('\n\n━━━ STUCK TOKEN CLASSIFICATION ━━━\n');
  const data = JSON.parse(fs.readFileSync('scan-results.json'));
  const agg = new Map();
  for (const p of data.pairs) {
    const add = (addr, sym, dec, raw) => {
      if (raw === '0') return;
      const k = addr.toLowerCase();
      const c = agg.get(k) || { sym, dec, raw: ethers.BigNumber.from(0) };
      c.raw = c.raw.add(ethers.BigNumber.from(raw));
      agg.set(k, c);
    };
    add(p.token0, p.symbol0, p.dec0, p.pfBal0);
    add(p.token1, p.symbol1, p.dec1, p.pfBal1);
    add(p.token0, p.symbol0, p.dec0, p.ibBal0);
    add(p.token1, p.symbol1, p.dec1, p.ibBal1);
  }
  console.log(`Pricing ${agg.size} unique tokens...\n`);
  const rows = [];
  let i = 0;
  for (const [addr, d] of agg.entries()) {
    i++;
    process.stdout.write(`\r  ${i}/${agg.size}     `);
    const pr = await fetchPrice(addr);
    const readable = Number(ethers.utils.formatUnits(d.raw, d.dec));
    const usd = readable * pr.price;
    let source;
    if (MULTICHAIN.has(addr)) source = '☠  MULTICHAIN (dead)';
    else if (d.sym.toLowerCase().startsWith('axl')) source = '✓  Axelar';
    else if (pr.liq > 5000) source = '✓  Liquid';
    else if (pr.liq > 100) source = '~  Low liquidity';
    else source = '?  Illiquid / unknown';
    rows.push({ addr, symbol: d.sym, amount: readable, price: pr.price, usd, liq: pr.liq, source });
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('\n');
  rows.sort((a, b) => b.usd - a.usd);
  console.log('Symbol'.padEnd(14) + 'Amount'.padStart(18) + 'USD'.padStart(12) + 'Liquidity'.padStart(14) + '  Source');
  console.log('─'.repeat(90));
  let recov = 0, dead = 0, unk = 0;
  for (const r of rows) {
    console.log(
      r.symbol.slice(0, 13).padEnd(14) +
      r.amount.toLocaleString('en-US', { maximumFractionDigits: 2 }).padStart(18) +
      ('$' + r.usd.toFixed(2)).padStart(12) +
      ('$' + r.liq.toFixed(0)).padStart(14) +
      '  ' + r.source
    );
    if (r.source.includes('MULTICHAIN')) dead += r.usd;
    else if (r.source.startsWith('✓')) recov += r.usd;
    else unk += r.usd;
  }
  console.log('─'.repeat(90));
  console.log(`\n✓  Recoverable (Axelar + Native + Liquid):  $${recov.toFixed(2)}`);
  console.log(`☠  Dead (Multichain, worthless):             $${dead.toFixed(2)}`);
  console.log(`?  Illiquid / unknown:                       $${unk.toFixed(2)}`);
}

(async () => {
  try { await checkVeNFTs(); } catch (e) { console.error('\nveNFT error:', e.message); }
  try { await classify(); } catch (e) { console.error('\nclassify error:', e.message); }
})();
