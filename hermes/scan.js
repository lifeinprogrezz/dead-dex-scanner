/**
 * Hermes Swap stuck-fees scanner.
 *
 * In Uniswap V2 forks, when factory.feeTo != 0, 1/6 of LP fees are minted as
 * LP tokens to the feeTo address every time mint()/burn()/sync() touches the
 * pair. Whoever controls feeTo can simply pair.transfer + pair.burn to redeem
 * the underlying tokens.
 *
 * For each pair we report:
 *   - feeTo's LP balance
 *   - underlying token0/token1 if those LPs were burned right now
 *     (= reserves * lpBalance / totalSupply)
 *   - whether feeTo is an EOA (claimable with the private key) or a contract
 *     (need to inspect its admin surface separately)
 */

const { ethers } = require('ethers');
const fs = require('fs');

const FACTORY = ethers.utils.getAddress('0xfe5e54a8e28534fffe89b9cfddfd18d3a90b42ca');

const RPCS = [
  process.env.RPC,
  'https://api.harmony.one',
  'https://api.s0.t.hmny.io',
  'https://harmony-mainnet.chainstacklabs.com',
  'https://1rpc.io/one',
].filter(Boolean);

const FACTORY_ABI = [
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
];

const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function kLast() view returns (uint256)',
];

const TOKEN_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

async function pickProvider() {
  for (const url of RPCS) {
    try {
      const p = new ethers.providers.StaticJsonRpcProvider({ url, timeout: 10000 });
      const bn = await Promise.race([p.getBlockNumber(), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 8000))]);
      console.log(`✓ ${url} @ block ${bn}`);
      return p;
    } catch (e) { console.log(`✗ ${url} ${e.message.slice(0, 50)}`); }
  }
  throw new Error('no rpc');
}

async function batch(items, fn, size = 8) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const settled = await Promise.allSettled(slice.map((it, j) => fn(it, i + j)));
    settled.forEach((s, j) => { out[i + j] = s.status === 'fulfilled' ? s.value : null; });
  }
  return out;
}

(async () => {
  const p = await pickProvider();
  const f = new ethers.Contract(FACTORY, FACTORY_ABI, p);
  const [feeTo, setter, lenBN] = await Promise.all([f.feeTo(), f.feeToSetter(), f.allPairsLength()]);
  const len = lenBN.toNumber();
  console.log(`\nFactory       ${FACTORY}`);
  console.log(`feeTo         ${feeTo}`);
  console.log(`feeToSetter   ${setter}`);
  console.log(`pairs         ${len}\n`);

  // Is feeTo an EOA or a contract?
  const feeToCode = await p.getCode(feeTo);
  const feeToIsContract = feeToCode !== '0x' && feeToCode.length > 2;
  console.log(`feeTo code:    ${feeToIsContract ? `CONTRACT (${(feeToCode.length - 2) / 2} bytes)` : 'EOA (no code)'}`);
  const setterCode = await p.getCode(setter);
  const setterIsContract = setterCode !== '0x' && setterCode.length > 2;
  console.log(`setter code:   ${setterIsContract ? `CONTRACT (${(setterCode.length - 2) / 2} bytes)` : 'EOA (no code)'}\n`);

  // Enumerate pairs
  const idxs = Array.from({ length: len }, (_, i) => i);
  process.stdout.write('Loading pair addresses... ');
  const pairs = await batch(idxs, (i) => f.allPairs(i), 8);
  console.log('done');

  // Read pair metadata + feeTo's LP balance + reserves
  process.stdout.write('Reading per-pair state... ');
  const data = await batch(pairs, async (addr) => {
    const c = new ethers.Contract(addr, PAIR_ABI, p);
    const [t0, t1, res, ts, bal] = await Promise.all([
      c.token0(), c.token1(), c.getReserves(), c.totalSupply(), c.balanceOf(feeTo),
    ]);
    return { addr, t0, t1, r0: res[0], r1: res[1], ts, lpBal: bal };
  });
  console.log('done');

  // Token metadata
  const tokenSet = new Set();
  for (const d of data) if (d) { tokenSet.add(d.t0); tokenSet.add(d.t1); }
  const toks = [...tokenSet];
  process.stdout.write(`Reading ${toks.length} token symbols/decimals... `);
  const tokInfo = await batch(toks, async (a) => {
    const c = new ethers.Contract(a, TOKEN_ABI, p);
    const [s, d] = await Promise.all([c.symbol().catch(() => '?'), c.decimals().catch(() => 18)]);
    return [a, { sym: s, dec: d }];
  });
  console.log('done');
  const T = Object.fromEntries(tokInfo.filter(Boolean));

  // Compute owed token0/token1 if feeTo were to burn its LPs
  const rows = [];
  let totalNonZero = 0;
  for (const d of data) {
    if (!d) continue;
    const t0i = T[d.t0] || { sym: '?', dec: 18 };
    const t1i = T[d.t1] || { sym: '?', dec: 18 };
    let o0 = ethers.BigNumber.from(0), o1 = ethers.BigNumber.from(0);
    if (!d.lpBal.isZero() && !d.ts.isZero()) {
      o0 = d.r0.mul(d.lpBal).div(d.ts);
      o1 = d.r1.mul(d.lpBal).div(d.ts);
      totalNonZero++;
    }
    rows.push({
      addr: d.addr,
      pair: `${t0i.sym}/${t1i.sym}`,
      t0: d.t0, t1: d.t1,
      symbol0: t0i.sym, symbol1: t1i.sym, dec0: t0i.dec, dec1: t1i.dec,
      reserve0: d.r0.toString(), reserve1: d.r1.toString(),
      totalSupply: d.ts.toString(),
      feeToLpBalance: d.lpBal.toString(),
      owed0: o0.toString(), owed1: o1.toString(),
    });
  }

  console.log(`\n━━━ FEE-TO LP BALANCES ━━━`);
  console.log(`${totalNonZero}/${len} pairs have non-zero LP balance for feeTo\n`);

  rows.sort((a, b) => {
    const an = Number(ethers.utils.formatUnits(a.owed0, a.dec0)) + Number(ethers.utils.formatUnits(a.owed1, a.dec1));
    const bn = Number(ethers.utils.formatUnits(b.owed0, b.dec0)) + Number(ethers.utils.formatUnits(b.owed1, b.dec1));
    return bn - an;
  });

  const tbl = rows.filter(r => r.feeToLpBalance !== '0').map(r => ({
    pair: r.pair,
    addr: r.addr.slice(0, 6) + '…' + r.addr.slice(-4),
    lp: ethers.utils.formatUnits(r.feeToLpBalance, 18),
    owed0: `${Number(ethers.utils.formatUnits(r.owed0, r.dec0)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${r.symbol0}`,
    owed1: `${Number(ethers.utils.formatUnits(r.owed1, r.dec1)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${r.symbol1}`,
  }));
  console.table(tbl);

  // Persist for downstream pricing
  const out = {
    scannedAt: new Date().toISOString(),
    factory: FACTORY,
    feeTo, feeToIsContract,
    feeToSetter: setter, feeToSetterIsContract: setterIsContract,
    pairsTotal: len,
    pairsWithFeeToBalance: totalNonZero,
    pairs: rows,
  };
  fs.writeFileSync('hermes-scan.json', JSON.stringify(out, null, 2));
  console.log(`\nWrote hermes-scan.json`);
})();
