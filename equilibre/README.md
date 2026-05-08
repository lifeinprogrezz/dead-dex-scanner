# equilibre — stuck-fees forensic scanner

Read-only on-chain forensics for **Équilibre Finance**, a dead Solidly/Velodrome V1 ve(3,3) fork on **Kava EVM (chainId 2222)**. Each script answers one hypothesis about the protocol's stuck-fees state. Nothing here sends transactions; every call is `eth_call` / `eth_getStorageAt` / `eth_getCode` / `eth_getLogs`.

## Usage

```bash
npm install              # ethers 5.7.2 only
node scan.js             # full forensic scan (~30s, ~3000 RPC calls)
RPC=https://kava-evm-rpc.publicnode.com node scan.js   # override RPC
MAX=20 node scan.js      # limit to first 20 pairs (debug)
node <any-other>.js      # diagnostic scripts; most read scan-results.json

# Scripts that need a voter's veNFT id:
VENFT_ID=12345 node recovery-path.js
VENFT_ID=12345 node bucket-usd.js
VENFT_ID=12345 node capture-check.js

# Wallet enumeration takes a comma-separated address list:
WALLETS=0xaaa...,0xbbb... node venft-and-classify.js
```

## Architecture

**`scan.js`** is the producer. It enumerates all 253 pairs from `PairFactory`, reads `PairFees` and `InternalBribe` balances, resolves admin addresses, and writes `scan-results.json` + `scan-results.csv`. Every other script is a **consumer** that loads `scan-results.json` to test a specific hypothesis without re-scanning.

The `scan.js` CFG block (lines 26–44) is the source of truth for the six core contract addresses (PairFactory, BribeFactory, GaugeFactory, Voter, VotingEscrow, Minter).

**Diagnostic scripts** (each tests one hypothesis):
- `admin-surface.js`, `check-owners.js`, `diagnose.js`, `bytecode-hash.js`, `selectors.js`, `probe-bribe-admin.js`, `probe-swap-out.js` — bytecode/selector probing for admin functions
- `verify-gauge-recovery.js`, `claim-check.js`, `capture-check.js`, `bucket-usd.js`, `recovery-path.js`, `optimal-weights.js` — recovery-path math (whether stuck fees can be reached)
- `value-ungauged.js`, `reality-check.js`, `venft-and-classify.js` — valuation and ground-truth checks (DexScreener prices, veNFT state)

## Conclusions already established

These are settled by prior investigation; treat as priors unless explicitly re-verifying:

- **PairFactory, BribeFactory, GaugeFactory are immutable.** Not EIP-1967 proxies; no `owner`/`admin`/`upgradeBeacon`. No way to add a recovery function via upgrade.
- **No admin sweep exists** on Voter, VotingEscrow, Minter, or InternalBribe. Bytecode-checked — `recoverERC20`, `sweep`, `rescue`, `withdraw*` selectors are absent.
- **InternalBribe `swapOutRewardToken` is a registry change only** — no token transfer in its body (verified by counting `transfer`/`transferFrom` opcodes).
- **InternalBribe balances tagged to 2023 epochs are structurally unreachable.** `notifyRewardAmount` does `_safeTransferFrom(token, msg.sender, ...)`, so retagging requires fresh capital.
- **The only recovery path that works:** `Gauge.claimFees()` (permissionless) → `InternalBribe.notifyRewardAmount` at current epoch → vote with veNFT → `getReward` after epoch ends. Run `recovery-path.js` for the live USD value.
- **Multichain-bridged tokens (anyUSDC `0xfA9343…`, anyUSDT `0xb44a9b…`, anyETH, anyWBTC, anyDAI) are dead** since July 2023 — discount to $0. Use axlUSDC `0xEB466342C4d449BC9f53A865D5Cb90586f405215` and native USDt `0x919C1c267BC06a7039e03fcc2eF738525769109c` for valuation.

## Solidly fee-flow model (used across diagnostics)

- `Pair._update0(amount)` on swap: `index0 += amount * 1e18 / totalSupply`, transfers fee tokens to `PairFees`.
- `Pair._updateFor(addr)` on LP balance change: `claimable0[addr] += balanceOf[addr] * (index0 - supplyIndex0[addr]) / 1e18`.
- `Pair.claimFees()` pays `claimable0/1[msg.sender]` and zeros it.
- `Gauge.claimFees()` calls `Pair.claimFees()` (the gauge holds LP for staked positions), then forwards to `InternalBribe.notifyRewardAmount` at `getEpochStart(block.timestamp)`.
- A freshly created gauge has `supplyIndex == current index` for its zero LP balance, so it cannot pull historical PairFees.

## Conventions

- Scripts use `ethers.providers.StaticJsonRpcProvider('https://evm.kava.io')` directly. The RPC silently drops large `eth_getLogs` ranges — chunk to ≤8000 blocks if reading logs.
- Pair JSON shape (in `scan-results.json`): `{ pair, symbol0, symbol1, dec0, dec1, token0, token1, stable, pairFees, gauge, internalBribe, reserve0, reserve1, totalSupply, pfBal0, pfBal1, ibBal0, ibBal1 }`. `gauge`/`internalBribe` may be the zero address.
