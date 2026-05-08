const { ethers } = require('ethers');
const fs = require('fs');

const data = JSON.parse(fs.readFileSync('scan-results.json'));
const pairs = data.pairs;

const ungaugedWithFees = pairs.filter(p =>
  (!p.gauge || p.gauge === '0x0000000000000000000000000000000000000000') &&
  (p.pfBal0 !== '0' || p.pfBal1 !== '0')
);

console.log(`\nUngauged pairs with stuck fees: ${ungaugedWithFees.length}\n`);

// Aggregate by token symbol
const agg = new Map();
for (const p of ungaugedWithFees) {
  const add = (sym, dec, raw) => {
    if (raw === '0') return;
    const cur = agg.get(sym) || { raw: ethers.BigNumber.from(0), dec, pairs: 0 };
    cur.raw = cur.raw.add(ethers.BigNumber.from(raw));
    cur.pairs++;
    agg.set(sym, cur);
  };
  add(p.symbol0, p.dec0, p.pfBal0);
  add(p.symbol1, p.dec1, p.pfBal1);
}

console.log('═══ STUCK IN UNGAUGED PAIRS, BY TOKEN ═══\n');
const sorted = [...agg.entries()].sort((a, b) => b[1].pairs - a[1].pairs);
for (const [sym, d] of sorted) {
  const readable = ethers.utils.formatUnits(d.raw, d.dec);
  console.log(`  ${sym.padEnd(14)} ${Number(readable).toLocaleString('en-US', {maximumFractionDigits: 4}).padStart(22)}  (${d.pairs} pairs)`);
}

console.log('\n═══ TOP 25 UNGAUGED PAIRS (by combined raw balance) ═══\n');
const rows = ungaugedWithFees.map(p => ({
  pair: `${p.symbol0}/${p.symbol1}`,
  stable: p.stable ? 's' : 'v',
  bal0: Number(ethers.utils.formatUnits(p.pfBal0, p.dec0)).toFixed(4),
  sym0: p.symbol0,
  bal1: Number(ethers.utils.formatUnits(p.pfBal1, p.dec1)).toFixed(4),
  sym1: p.symbol1,
  addr: p.pair.slice(0, 10) + '...',
}));
rows.sort((a, b) => (parseFloat(b.bal0) + parseFloat(b.bal1)) - (parseFloat(a.bal0) + parseFloat(a.bal1)));
console.table(rows.slice(0, 25));

console.log('\n═══ ALSO — GAUGED PAIRS WITH STUCK PAIRFEES (distribute() not called) ═══\n');
const gaugedWithStuck = pairs.filter(p =>
  p.gauge && p.gauge !== '0x0000000000000000000000000000000000000000' &&
  (p.pfBal0 !== '0' || p.pfBal1 !== '0')
);
console.log(`Gauged pairs with fees stuck in PairFees (should have been pushed already): ${gaugedWithStuck.length}`);
const gAgg = new Map();
for (const p of gaugedWithStuck) {
  const add = (sym, dec, raw) => {
    if (raw === '0') return;
    const cur = gAgg.get(sym) || { raw: ethers.BigNumber.from(0), dec, pairs: 0 };
    cur.raw = cur.raw.add(ethers.BigNumber.from(raw));
    cur.pairs++;
    gAgg.set(sym, cur);
  };
  add(p.symbol0, p.dec0, p.pfBal0);
  add(p.symbol1, p.dec1, p.pfBal1);
}
for (const [sym, d] of [...gAgg.entries()].sort((a, b) => b[1].pairs - a[1].pairs)) {
  const readable = ethers.utils.formatUnits(d.raw, d.dec);
  console.log(`  ${sym.padEnd(14)} ${Number(readable).toLocaleString('en-US', {maximumFractionDigits: 4}).padStart(22)}  (${d.pairs} pairs)`);
}
