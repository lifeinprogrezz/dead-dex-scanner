# dead-dex-scanner

Read-only on-chain forensics toolkits for two abandoned DEX forks. Each subdirectory is a self-contained Node.js project that enumerates pools, traces fee flow, and tests recovery hypotheses without sending a single transaction — every call is `eth_call` / `eth_getStorageAt` / `eth_getCode` / `eth_getLogs`.

| Project | Target | Chain | Style | Question it answers |
|---|---|---|---|---|
| [`equilibre/`](./equilibre) | Équilibre Finance | Kava EVM (chainId 2222) | Solidly / Velodrome V1 ve(3,3) fork | Are stuck `PairFees` and `InternalBribe` balances reachable, and what's the live USD value of the only working recovery path? |
| [`hermes/`](./hermes) | Hermes Swap | Harmony (chainId 1666600000) | Uniswap V2 fork | Is `factory.feeTo`-accumulated LP recoverable, and what would `pair.burn()` actually pay out at current prices? |

Both share the same skeleton: a `scan.js` producer that writes a JSON snapshot, plus a fan of small consumer scripts that load the snapshot to test one hypothesis each. Diagnostics are intentionally disposable — the value is reproducibility, not reuse.

## Stack
- Node.js 20.x
- `ethers` 5.7.2 (not v6 — API differs)
- No build step, no tests, no linter

## Disclaimer
Pure research code. The tools never send transactions and never need a private key. Conclusions about recovery paths and dollar values are point-in-time snapshots; verify against current chain state before acting on anything.

## License

MIT — free to use, modify, and distribute. See [`LICENSE`](./LICENSE).
