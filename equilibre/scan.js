#!/usr/bin/env node
/**
 * Equilibre Stuck-Fees Forensic Scanner (Node.js)
 *
 * Reads every Pair from PairFactory, queries PairFees + InternalBribe balances,
 * and prints admin addresses (factory owners, governor, emergency council) so
 * you can match them against your wallets before planning any recovery.
 *
 * Usage:
 *   mkdir equilibre-scan && cd equilibre-scan
 *   npm init -y && npm install ethers@5.7.2
 *   # save this file as scan.js
 *   node scan.js
 *
 * Override RPC if needed:
 *   RPC=https://kava-evm-rpc.publicnode.com node scan.js
 *
 * Limit scan for testing:
 *   MAX=20 node scan.js
 */

const { ethers } = require('ethers');
const fs = require('fs');

// ───────────────────────── CONFIG ─────────────────────────
const CFG = {
  rpcList: [
    process.env.RPC,
    'https://evm.kava.io',
    'https://kava-evm-rpc.publicnode.com',
    'https://rpc.ankr.com/kava_evm',
    'https://kava-pokt.nodies.app',
  ].filter(Boolean),
  contracts: {
    PairFactory:   '0xA138FAFc30f6Ec6980aAd22656F2F11C38B56a95',
    BribeFactory:  '0x7B14b7288D50810a6982149B107238065AA7fcb7',
    GaugeFactory:  '0xa337E9426d080970b026caFfb4a83D185b85A124',
    Voter:         '0x4eB2B9768da9Ea26E3aBe605c9040bC12F236a59',
    VotingEscrow:  '0x35361C9c2a324F5FB8f3aed2d7bA91CE1410893A',
    Minter:        '0x46a88F88584c9d4751dB36DA9127F12E4DCAD6B8',
  },
  batchSize: 12,
  maxPairs: parseInt(process.env.MAX || '0'),
};

// Minimal ABIs
const ABI = {
  ownable:   ['function owner() view returns (address)'],
  factory:   [
    'function allPairsLength() view returns (uint256)',
    'function allPairs(uint256) view returns (address)',
    'function pauser() view returns (address)',
    'function feeManager() view returns (address)',
  ],
  pair:      [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fees() view returns (address)',
    'function stable() view returns (bool)',
    'function symbol() view returns (string)',
    'function reserve0() view returns (uint256)',
    'function reserve1() view returns (uint256)',
    'function totalSupply() view returns (uint256)',
  ],
  token:     [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
  ],
  voter:     [
    'function gauges(address) view returns (address)',
    'function internal_bribes(address) view returns (address)',
    'function governor() view returns (address)',
    'function emergencyCouncil() view returns (address)',
  ],
  ve:        ['function team() view returns (address)'],
  minter:    ['function team() view returns (address)'],
};

// Terminal colors
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
};
const H1 = (s) => `\n${c.bold}${c.yellow}━━━ ${s} ━━━${c.reset}\n`;
const H2 = (s) => `\n${c.bold}${c.cyan}▸ ${s}${c.reset}`;

function fmt(raw, dec) {
  if (!raw || raw.isZero()) return '0';
  const n = Number(ethers.utils.formatUnits(raw, dec));
  if (n < 0.0001) return n.toExponential(2);
  if (n < 1)     return n.toFixed(6);
  if (n < 1000)  return n.toFixed(4);
  if (n < 1e6)   return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return (n / 1e6).toFixed(2) + 'M';
}
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '0x0';

async function batch(items, fn, size = CFG.batchSize, label = '') {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const settled = await Promise.allSettled(slice.map((it, j) => fn(it, i + j)));
    settled.forEach((s, j) => {
      out[i + j] = s.status === 'fulfilled' ? s.value : null;
    });
    if (label) process.stdout.write(`\r  ${label} ${Math.min(i + size, items.length)}/${items.length}  `);
  }
  if (label) process.stdout.write('\n');
  return out;
}

async function pickProvider() {
  for (const url of CFG.rpcList) {
    try {
      const p = new ethers.providers.StaticJsonRpcProvider({ url, timeout: 15000 });
      const bn = await Promise.race([
        p.getBlockNumber(),
        new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 8000)),
      ]);
      console.log(`${c.green}✓${c.reset} Connected to ${url} ${c.dim}@ block ${bn}${c.reset}`);
      return p;
    } catch (e) {
      console.log(`${c.red}✗${c.reset} ${url} — ${e.message}`);
    }
  }
  throw new Error('No RPC endpoint reachable');
}

async function main() {
  console.log(H1('ÉQUILIBRE · STUCK FEES FORENSICS'));
  const provider = await pickProvider();

  // ─── 1. ADMIN SURFACE ───
  console.log(H1('ADMIN ADDRESSES (check these against your wallets)'));

  const admins = {};
  const adminChecks = [
    { name: 'PairFactory.owner()',   target: CFG.contracts.PairFactory,  abi: ABI.ownable, fn: 'owner',  crit: 'CAN upgrade all Pairs via updateBeacon' },
    { name: 'PairFactory.feeManager()', target: CFG.contracts.PairFactory, abi: ABI.factory, fn: 'feeManager', crit: 'Can set swap fee %' },
    { name: 'PairFactory.pauser()',  target: CFG.contracts.PairFactory,  abi: ABI.factory, fn: 'pauser', crit: 'Can pause swaps' },
    { name: 'BribeFactory.owner()',  target: CFG.contracts.BribeFactory, abi: ABI.ownable, fn: 'owner',  crit: 'CAN upgrade all Bribes via updateBeacon' },
    { name: 'GaugeFactory.owner()',  target: CFG.contracts.GaugeFactory, abi: ABI.ownable, fn: 'owner',  crit: 'CAN upgrade all Gauges via updateBeacon' },
    { name: 'Voter.governor()',      target: CFG.contracts.Voter,        abi: ABI.voter,   fn: 'governor', crit: 'Can whitelist tokens, set governor' },
    { name: 'Voter.emergencyCouncil()', target: CFG.contracts.Voter,     abi: ABI.voter,   fn: 'emergencyCouncil', crit: 'Can kill/revive gauges' },
    { name: 'VotingEscrow.team()',   target: CFG.contracts.VotingEscrow, abi: ABI.ve,      fn: 'team', crit: 'Can swap bribe reward tokens' },
    { name: 'Minter.team()',         target: CFG.contracts.Minter,       abi: ABI.minter,  fn: 'team', crit: 'Receives team emissions' },
  ];

  for (const ch of adminChecks) {
    try {
      const contract = new ethers.Contract(ch.target, ch.abi, provider);
      const addr = await contract[ch.fn]();
      admins[ch.name] = addr;
      const isCritical = ch.name.includes('.owner()');
      const mark = isCritical ? `${c.bold}${c.yellow}★${c.reset}` : ' ';
      console.log(`${mark} ${c.bold}${ch.name.padEnd(38)}${c.reset} ${c.green}${addr}${c.reset}`);
      console.log(`    ${c.dim}${ch.crit}${c.reset}`);
    } catch (e) {
      console.log(`  ${c.red}${ch.name}: FAILED (${e.message.slice(0, 60)})${c.reset}`);
    }
  }

  // Dedupe unique admin addresses
  const uniqueAdmins = [...new Set(Object.values(admins).map((a) => a?.toLowerCase()).filter(Boolean))];
  console.log(`\n${c.bold}Unique admin addresses (${uniqueAdmins.length}):${c.reset}`);
  uniqueAdmins.forEach((a) => console.log(`  ${c.magenta}${a}${c.reset}`));
  console.log(`\n${c.yellow}→ Match these against your wallets. The ★ entries are the ones that matter for upgrading contracts to add a recovery function.${c.reset}`);

  // ─── 2. ENUMERATE PAIRS ───
  console.log(H1('ENUMERATING PAIRS'));
  const factory = new ethers.Contract(CFG.contracts.PairFactory, ABI.factory, provider);
  const voter = new ethers.Contract(CFG.contracts.Voter, ABI.voter, provider);

  const total = (await factory.allPairsLength()).toNumber();
  const limit = CFG.maxPairs > 0 ? Math.min(CFG.maxPairs, total) : total;
  console.log(`Factory reports ${total} total pairs. Scanning ${limit}.`);

  const indices = Array.from({ length: limit }, (_, i) => i);
  const addresses = await batch(indices, (i) => factory.allPairs(i), CFG.batchSize, 'Addresses');
  const validAddrs = addresses.filter((a) => a && a !== ethers.constants.AddressZero);

  // ─── 3. PAIR METADATA ───
  console.log(H2('Reading pair metadata (token0, token1, fees, stable, reserves)'));
  const pairs = await batch(validAddrs, async (addr) => {
    const p = new ethers.Contract(addr, ABI.pair, provider);
    const [token0, token1, pairFees, stable, reserve0, reserve1, totalSupply] = await Promise.all([
      p.token0().catch(() => null),
      p.token1().catch(() => null),
      p.fees().catch(() => null),
      p.stable().catch(() => false),
      p.reserve0().catch(() => ethers.BigNumber.from(0)),
      p.reserve1().catch(() => ethers.BigNumber.from(0)),
      p.totalSupply().catch(() => ethers.BigNumber.from(0)),
    ]);
    return { addr, token0, token1, pairFees, stable, reserve0, reserve1, totalSupply };
  }, CFG.batchSize, 'Metadata');
  const valid = pairs.filter((p) => p && p.token0 && p.token1 && p.pairFees);
  console.log(`  ${c.green}${valid.length}${c.reset} pairs with valid metadata`);

  // ─── 4. TOKEN METADATA ───
  console.log(H2('Reading token metadata (symbol, decimals)'));
  const uniqTokens = [...new Set(valid.flatMap((p) => [p.token0, p.token1]))];
  const tokenMetaArr = await batch(uniqTokens, async (addr) => {
    const t = new ethers.Contract(addr, ABI.token, provider);
    const [symbol, decimals] = await Promise.all([
      t.symbol().catch(() => '???'),
      t.decimals().catch(() => 18),
    ]);
    return { addr: addr.toLowerCase(), symbol, decimals };
  }, CFG.batchSize, 'Tokens');
  const tokens = new Map();
  tokenMetaArr.forEach((tm) => tm && tokens.set(tm.addr, tm));

  // ─── 5. PAIRFEES BALANCES ───
  console.log(H2('Reading PairFees balances'));
  const pfBals = await batch(valid, async (p) => {
    const t0 = new ethers.Contract(p.token0, ABI.token, provider);
    const t1 = new ethers.Contract(p.token1, ABI.token, provider);
    const [b0, b1] = await Promise.all([
      t0.balanceOf(p.pairFees).catch(() => ethers.BigNumber.from(0)),
      t1.balanceOf(p.pairFees).catch(() => ethers.BigNumber.from(0)),
    ]);
    return { b0, b1 };
  }, CFG.batchSize, 'PairFees');

  // ─── 6. GAUGES + INTERNAL BRIBES ───
  console.log(H2('Checking gauges'));
  const gauges = await batch(
    valid,
    (p) => voter.gauges(p.addr).catch(() => ethers.constants.AddressZero),
    CFG.batchSize,
    'Gauges'
  );

  console.log(H2('Resolving InternalBribe addresses'));
  const ibAddrs = await batch(
    gauges,
    (g) => (g && g !== ethers.constants.AddressZero
      ? voter.internal_bribes(g).catch(() => ethers.constants.AddressZero)
      : Promise.resolve(ethers.constants.AddressZero)),
    CFG.batchSize,
    'Bribes'
  );

  console.log(H2('Reading InternalBribe balances'));
  const ibBals = await batch(valid, async (p, i) => {
    const ib = ibAddrs[i];
    if (!ib || ib === ethers.constants.AddressZero) {
      return { b0: ethers.BigNumber.from(0), b1: ethers.BigNumber.from(0) };
    }
    const t0 = new ethers.Contract(p.token0, ABI.token, provider);
    const t1 = new ethers.Contract(p.token1, ABI.token, provider);
    const [b0, b1] = await Promise.all([
      t0.balanceOf(ib).catch(() => ethers.BigNumber.from(0)),
      t1.balanceOf(ib).catch(() => ethers.BigNumber.from(0)),
    ]);
    return { b0, b1 };
  }, CFG.batchSize, 'IB-bal');

  // ─── 7. ASSEMBLE & ANALYZE ───
  const results = valid.map((p, i) => ({
    pair: p.addr,
    symbol0: tokens.get(p.token0.toLowerCase())?.symbol || '?',
    symbol1: tokens.get(p.token1.toLowerCase())?.symbol || '?',
    dec0:    tokens.get(p.token0.toLowerCase())?.decimals ?? 18,
    dec1:    tokens.get(p.token1.toLowerCase())?.decimals ?? 18,
    token0: p.token0, token1: p.token1,
    stable: p.stable,
    pairFees: p.pairFees,
    gauge: gauges[i],
    internalBribe: ibAddrs[i],
    reserve0: p.reserve0, reserve1: p.reserve1,
    totalSupply: p.totalSupply,
    pfBal0: pfBals[i]?.b0 || ethers.BigNumber.from(0),
    pfBal1: pfBals[i]?.b1 || ethers.BigNumber.from(0),
    ibBal0: ibBals[i]?.b0 || ethers.BigNumber.from(0),
    ibBal1: ibBals[i]?.b1 || ethers.BigNumber.from(0),
  }));

  // ─── 8. SUMMARY ───
  console.log(H1('SUMMARY'));
  const nonZero = results.filter(
    (r) => !r.pfBal0.isZero() || !r.pfBal1.isZero() || !r.ibBal0.isZero() || !r.ibBal1.isZero()
  );
  const gauged   = results.filter((r) => r.gauge && r.gauge !== ethers.constants.AddressZero);
  const ungauged = results.filter((r) => !r.gauge || r.gauge === ethers.constants.AddressZero);
  const ungaugedWithFees = ungauged.filter((r) => !r.pfBal0.isZero() || !r.pfBal1.isZero());

  console.log(`  Pairs scanned:           ${c.bold}${results.length}${c.reset}`);
  console.log(`  Non-zero stuck balances: ${c.bold}${c.yellow}${nonZero.length}${c.reset}`);
  console.log(`  Gauged pairs:            ${c.green}${gauged.length}${c.reset}`);
  console.log(`  Ungauged pairs:          ${c.red}${ungauged.length}${c.reset}  ${c.dim}(${ungaugedWithFees.length} with fees stuck — no distribution route)${c.reset}`);

  // Token aggregation
  console.log(H1('STUCK BALANCES BY TOKEN'));
  const agg = new Map();
  for (const r of results) {
    const t0sym = r.symbol0, t1sym = r.symbol1;
    for (const [sym, dec, raw] of [
      [t0sym, r.dec0, r.pfBal0],
      [t1sym, r.dec1, r.pfBal1],
      [t0sym, r.dec0, r.ibBal0],
      [t1sym, r.dec1, r.ibBal1],
    ]) {
      if (raw.isZero()) continue;
      const cur = agg.get(sym) || { raw: ethers.BigNumber.from(0), dec, count: 0 };
      cur.raw = cur.raw.add(raw);
      cur.count++;
      agg.set(sym, cur);
    }
  }
  const sortedAgg = [...agg.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [sym, d] of sortedAgg) {
    console.log(`  ${c.bold}${sym.padEnd(10)}${c.reset} ${fmt(d.raw, d.dec).padStart(18)}  ${c.dim}across ${d.count} positions${c.reset}`);
  }

  // Ungauged pairs with fees — the biggest red flag
  if (ungaugedWithFees.length > 0) {
    console.log(H1('UNGAUGED PAIRS WITH STUCK FEES (no voter route)'));
    console.log(`${c.dim}These fees attribute per-LP via claimable mappings, but no one's incentivized to claim.${c.reset}\n`);
    const rows = ungaugedWithFees
      .map((r) => ({
        pair: `${r.symbol0}/${r.symbol1} ${r.stable ? '(s)' : '(v)'}`,
        addr: short(r.pair),
        b0: fmt(r.pfBal0, r.dec0) + ' ' + r.symbol0,
        b1: fmt(r.pfBal1, r.dec1) + ' ' + r.symbol1,
      }))
      .sort((a, b) => b.b0.localeCompare(a.b0));
    console.table(rows);
  }

  // Top non-zero pairs
  console.log(H1('TOP PAIRS WITH STUCK BALANCES'));
  const topRows = nonZero
    .map((r) => {
      const hasGauge = r.gauge && r.gauge !== ethers.constants.AddressZero;
      return {
        pair: `${r.symbol0}/${r.symbol1} ${r.stable ? '(s)' : '(v)'}`,
        addr: short(r.pair),
        gauge: hasGauge ? '✓' : '✗',
        pf0: fmt(r.pfBal0, r.dec0) + ' ' + r.symbol0,
        pf1: fmt(r.pfBal1, r.dec1) + ' ' + r.symbol1,
        ib0: fmt(r.ibBal0, r.dec0) + ' ' + r.symbol0,
        ib1: fmt(r.ibBal1, r.dec1) + ' ' + r.symbol1,
      };
    })
    .slice(0, 40);
  console.table(topRows);

  // ─── 9. WRITE FILES ───
  const jsonPath = 'scan-results.json';
  const csvPath = 'scan-results.csv';
  fs.writeFileSync(jsonPath, JSON.stringify({
    scannedAt: new Date().toISOString(),
    admins,
    summary: {
      total: results.length,
      nonZero: nonZero.length,
      gauged: gauged.length,
      ungauged: ungauged.length,
      ungaugedWithFees: ungaugedWithFees.length,
    },
    pairs: results.map((r) => ({
      ...r,
      reserve0: r.reserve0.toString(), reserve1: r.reserve1.toString(),
      totalSupply: r.totalSupply.toString(),
      pfBal0: r.pfBal0.toString(), pfBal1: r.pfBal1.toString(),
      ibBal0: r.ibBal0.toString(), ibBal1: r.ibBal1.toString(),
    })),
  }, null, 2));

  const header = 'pair,symbol0,symbol1,stable,gauge,internal_bribe,pairfees,pf_bal0_raw,pf_bal0_fmt,pf_bal1_raw,pf_bal1_fmt,ib_bal0_raw,ib_bal0_fmt,ib_bal1_raw,ib_bal1_fmt';
  const csvRows = results.map((r) => [
    r.pair, r.symbol0, r.symbol1, r.stable, r.gauge || '', r.internalBribe || '', r.pairFees,
    r.pfBal0.toString(), fmt(r.pfBal0, r.dec0),
    r.pfBal1.toString(), fmt(r.pfBal1, r.dec1),
    r.ibBal0.toString(), fmt(r.ibBal0, r.dec0),
    r.ibBal1.toString(), fmt(r.ibBal1, r.dec1),
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  fs.writeFileSync(csvPath, header + '\n' + csvRows.join('\n'));

  console.log(H1('DONE'));
  console.log(`  Wrote ${c.cyan}${jsonPath}${c.reset}`);
  console.log(`  Wrote ${c.cyan}${csvPath}${c.reset}`);
  console.log(`\n${c.bold}Share the admin block above with me and I'll help you plan next steps.${c.reset}`);
}

main().catch((e) => {
  console.error(`\n${c.red}${c.bold}Fatal:${c.reset} ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
