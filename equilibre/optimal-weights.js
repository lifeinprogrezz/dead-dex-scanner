
const { ethers } = require('ethers');
const fs = require('fs');
const p = new ethers.providers.StaticJsonRpcProvider('https://evm.kava.io');
const scan = JSON.parse(fs.readFileSync('scan-results.json'));

const targetAddrs = [
  '0xeb466342c4d449bc9f53a865d5cb90586f405215',
  '0x919c1c267bc06a7039e03fcc2ef738525769109c',
].map(a => a.toLowerCase());

const candidates = scan.pairs.filter(pp => {
  const hasGauge = pp.gauge && pp.gauge !== '0x0000000000000000000000000000000000000000';
  const hasTarget = targetAddrs.includes(pp.token0.toLowerCase()) || targetAddrs.includes(pp.token1.toLowerCase());
  const hasFees = pp.pfBal0 !== '0' || pp.pfBal1 !== '0' || pp.ibBal0 !== '0' || pp.ibBal1 !== '0';
  return hasGauge && hasTarget && hasFees;
});

const bribeAbi = ['function totalSupply() view returns (uint256)'];

(async () => {
  const pairs = [];
  for (const pp of candidates) {
    const ib = new ethers.Contract(pp.internalBribe, bribeAbi, p);
    const stale = await ib.totalSupply();
    let fees = 0;
    const add = (addr, dec, pf, ibBal) => {
      fees += Number(ethers.utils.formatUnits(ethers.BigNumber.from(pf).add(ethers.BigNumber.from(ibBal)), dec));
    };
    add(pp.token0, pp.dec0, pp.pfBal0, pp.ibBal0);
    add(pp.token1, pp.dec1, pp.pfBal1, pp.ibBal1);
    pairs.push({
      pair: pp.symbol0 + '/' + pp.symbol1,
      stale: Number(ethers.utils.formatUnits(stale, 18)),
      fees,
    });
  }

  const TOTAL_VP = 11095842.7;
  const STEPS = 5000;
  const alloc = new Array(pairs.length).fill(0);
  const step = TOTAL_VP / STEPS;
  for (let s = 0; s < STEPS; s++) {
    let bestI = 0, bestGain = -1;
    for (let i = 0; i < pairs.length; i++) {
      const cur = alloc[i];
      const nxt = cur + step;
      const gain = pairs[i].fees * (nxt/(nxt+pairs[i].stale) - cur/(cur+pairs[i].stale));
      if (gain > bestGain) { bestGain = gain; bestI = i; }
    }
    alloc[bestI] += step;
  }

  let totalUsd = 0;
  const out = [];
  for (let i = 0; i < pairs.length; i++) {
    if (alloc[i] > 0.01) {
      const cap = alloc[i] / (alloc[i] + pairs[i].stale);
      const usd = pairs[i].fees * cap;
      totalUsd += usd;
      out.push({ ...pairs[i], allocPct: alloc[i]/TOTAL_VP*100, capPct: cap*100, usd });
    }
  }
  out.sort((a,b) => b.usd - a.usd);
  console.log('
━━━ OPTIMAL ALLOCATION ━━━
');
  console.log('Pair'.padEnd(22) + 'Alloc%'.padStart(10) + 'Cap%'.padStart(10) + '$'.padStart(12));
  console.log('-'.repeat(54));
  for (const r of out) {
    console.log(r.pair.padEnd(22) + r.allocPct.toFixed(2).padStart(10) + r.capPct.toFixed(1).padStart(10) + ('$'+r.usd.toFixed(2)).padStart(12));
  }
  console.log('-'.repeat(54));
  console.log('TOTAL expected:  $' + totalUsd.toFixed(2));
  const skipped = pairs.filter((p,i) => alloc[i] <= 0.01);
  if (skipped.length) {
    console.log('
Skipped (zero allocation):');
    skipped.forEach(p => console.log('  ' + p.pair + ' — stale:' + p.stale.toFixed(0) + ' fees:$' + p.fees.toFixed(2)));
  }
})();
