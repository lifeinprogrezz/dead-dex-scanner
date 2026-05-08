# hermes — feeTo recovery scanner

Read-only on-chain forensics for **Hermes Swap**, a dead Uniswap V2 fork on **Harmony (chainId 1666600000)**. Investigates whether `factory.feeTo`-accumulated LP tokens are recoverable. Companion to [`../equilibre`](../equilibre) — same general approach, but Hermes is V2-flavored, not ve(3,3).

## Usage

```bash
npm install                  # ethers 5.7.2 only
node scan.js                 # enumerate all 50 pairs, write hermes-scan.json
RPC=https://api.s0.t.hmny.io node scan.js   # override RPC

node probe-factory.js        # quick: feeTo / feeToSetter / pair count
node probe-feeto.js          # admin-surface probe of feeTo + feeToSetter
node extract-selectors.js [addr]   # dump every PUSH4 selector from a contract's bytecode
node price-totals.js         # USD valuation of recoverable amounts via DexScreener
```

## Architecture

**`scan.js`** is the producer. Iterates `Factory.allPairs(0..N)`, queries each pair's reserves + totalSupply + `balanceOf(feeTo)`, and writes `hermes-scan.json`. Every other script consumes that file or directly probes addresses.

The factory address is the source of truth — derived from the upstream repo's `contracts.json`:
- **Factory**: `0xfE5e54A8E28534fFfe89b9cfDDfd18d3a90B42cA`
- **feeTo**: `0xD86994b247461A24943C30b544FF5D88d4b90cdC` (a SushiMaker-style fee converter contract, not an EOA)
- **feeTo.owner()**: EOA `0x1109c5BB8Abb99Ca3BBeff6E60F5d3794f4e0473` (controls the converter)
- **feeToSetter**: `0xD9Fa2863B26bD3a12FbD211751DCEfe041D3034F` (admin = `0x208CD487...`, a 162-byte proxy)
- **Router** (referenced by feeTo): `0x0A34fE479d2442fB51333ac373dD2CBF02B6D949`

## Conclusions already established

- **`feeTo` is a SushiMaker-style fee converter**, not an EOA. It calls `Router.removeLiquidity` (`0xbaa2abde`) and `swapExactTokensForTokens` (`0x38ed1739`) under owner-gated functions. 46 selectors in dispatch; only `owner()`, `transferOwnership`, `router()` are publicly known.
- **Recovery path:** the EOA at `0x1109c5BB...0473` calls one of the unknown owner-only selectors on `feeTo` to trigger conversion. No public `sweep`/`rescue`/`withdraw` exists.
- **22/50 pairs have non-zero LP balance for `feeTo`**, but realistic dollar value is **~$0.99** at current spot prices (top contributors: WONE, depegged Horizon-bridge tokens, HRMS).
- **Horizon-bridge tokens** (June 2022 hack) — `1USDC`, `1USDT`, `1ETH`, `1WBTC`, `1DAI`, `1BTC` — trade at ~1% of nominal value with no redemption path. Treat them as ~$0 regardless of nominal balance.
- **`HRMS` and `IRIS` are essentially worthless** (`$3.19e-6` and `$0.00105` respectively, with sub-$50 liquidity). Hermes had a planned PLTS→HRMS migration that never fully landed.

## Conventions

- Harmony addresses must be checksummed correctly. The factory `0xfE5e54A8E28534fFfe89b9cfDDfd18d3a90B42cA` is the on-chain checksum form; if you copy-paste from older docs, lowercase first then `ethers.utils.getAddress(lower)` to normalize.
- Use `ethers.providers.StaticJsonRpcProvider` directly. RPC fallback list: `api.harmony.one`, `api.s0.t.hmny.io`, `harmony-mainnet.chainstacklabs.com`, `1rpc.io/one`. They have wildly different reliability — `scan.js`'s `pickProvider()` walks the list.
- DexScreener returns junk price data when there's a token-symbol collision across chains (e.g., a "Neurons" pair manipulating WONE pricing). For canonical tokens like WONE, cross-check with CoinGecko (`harmony` id) — current WONE is **~$0.00226**, anything in the $10⁴ range is wrong.
- `hermes-scan.json` shape: `{ scannedAt, factory, feeTo, feeToIsContract, feeToSetter, pairsTotal, pairsWithFeeToBalance, pairs: [{ addr, pair, t0, t1, symbol0, symbol1, dec0, dec1, reserve0, reserve1, totalSupply, feeToLpBalance, owed0, owed1 }] }`.
- `owed0/owed1` are computed as `reserve * lpBalance / totalSupply` — that's what the converter would receive if it called `pair.burn()` right now. Real recovery would also incur slippage on the subsequent token swap.
