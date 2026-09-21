# agentpay — a budgeted x402 wallet for AI agents

x402 payments with a budget around them: a payer agent signs a single-use **USDC authorization** (EIP-3009) for each paid HTTP call, the payee's **facilitator** settles it on chain before the response goes out, and the agent's wallet only ever signs inside an **intent mandate** — a budget the human approved once (purpose, limit, validity, allowed hosts). The protocol is [x402](https://github.com/coinbase/x402) V2, `exact` scheme, implemented with the official `@x402/*` packages; what this repository adds is the payer-side budget layer, a self-hostable facilitator, a paywall helper, a CLI with a skill file for LLM agents, and a demo that runs all of it on a local chain.

```
 payer agent (MandateWallet)        payee (express + @x402/express)     facilitator (@agentpay/facilitator)   USDC (EIP-3009)
     │  GET /predict                      │                                    │                                   │
     │────────────────────────────────────>│ 402 + PAYMENT-REQUIRED (offer)     │                                   │
     │<────────────────────────────────────│                                    │                                   │
     │  policy gate + reserve budget       │                                    │                                   │
     │  sign TransferWithAuthorization     │                                    │                                   │
     │  GET /predict + PAYMENT-SIGNATURE   │                                    │                                   │
     │────────────────────────────────────>│ POST /verify ─────────────────────>│ signature, window, amount,        │
     │                                     │ run the handler (response buffered)│ balance, nonce, simulation        │
     │                                     │ POST /settle ─────────────────────>│ transferWithAuthorization ───────>│ payer −amount, payee +amount
     │  200 + PAYMENT-RESPONSE {transaction}│<───────────────────────────────────│ (facilitator pays the gas)        │
     │<────────────────────────────────────│                                    │                                   │
     │  ledger: settled; reservation → spent                                    │                                   │
```

The payer needs only USDC in its own account: no contract to deposit into, no ETH, no approval. One authorization pays for one delivery; the chain refuses a reused nonce.

## Quickstart

```bash
npm install
npm test            # every workspace (contract / facilitator / payee / wallet tests spawn their own hardhat node)
npm run demo        # fresh chain + facilitator + payee + agent, 10 scenarios, exit 0 iff all pass
```

The demo prints, among other things: a paid call whose on-chain balances **move inside the same request** (payer −$0.001, payee +$0.001, tx hash in `PAYMENT-RESPONSE`), a budget refusal *before* anything is signed, a replay refused by the payee and by the facilitator, twenty concurrent calls settled as twenty transactions, a failed handler that is never charged, the official `@x402/fetch` client paying the same payee, and an authorization that expires by chain time and releases its budget.

Node ≥ 22 (`.nvmrc`). The root `npm test` includes the demo's end-to-end test, which binds ports 8545 / 3001 / 4021, so it cannot run while a local `hardhat node`, facilitator or payee from "Running the pieces yourself" is up. CI (`.github/workflows/ci.yml`) runs `npm run typecheck`, `npm test`, then `npm run gen-abi` and fails if `packages/contracts/src/abi.ts` differs from what is committed — after touching `MockUSDC.sol`, regenerate and commit the ABI.

## Packages

| workspace | what it is |
|---|---|
| `packages/core` | Money parsing, CAIP helpers, the EIP-3009 ABI slice, error taxonomy, `payment_model_context` hints for LLM agents; re-exports the `@x402/core` wire types |
| `packages/contracts` | `MockUSDC.sol` (EIP-3009 test token) for local chains, Multicall3 bytecode, deployment records (`deployments/base-sepolia.json` is static: Circle's USDC), generated ABI |
| `packages/facilitator` | Self-hostable x402 facilitator: `@x402/core`'s `x402Facilitator` + the `@x402/evm` exact scheme behind `node:http` (`/supported`, `/verify`, `/settle`, `/health`), with asset/payee allowlists, a send lock over viem's nonce manager, and 503s for RPC outages |
| `packages/payee` | `createPaywall()`: one x402 resource server per service, `charge(price)` for express middleware (`@x402/express`), an in-flight guard so one authorization buys one delivery, hints in the initial 402 body |
| `packages/wallet` | `MandateWallet`: intent mandates (user-approved budgets), policy gate before signing, `fetch()` that answers 402s through the official x402 client, JSONL ledger, `reconcile()` against the chain, `report()` |
| `packages/cli` | `agentpay` CLI (JSON out, exit codes) + `SKILL.md` for LLM agents |
| `demo` | One-command end-to-end scenario runner and its test |

## Using it as a submodule (e.g. inside Kairos)

This repository is a component, not a host: the product that pays (Kairos) keeps its own repository and pulls this one in as a git submodule.

```bash
git submodule add https://github.com/linqizhe07/agentpay modules/payment   # in the host repo
git submodule update --init
(cd modules/payment && npm install)
```

The host then imports the SDK packages by path or workspace: `@agentpay/wallet` for the paying agent, `@agentpay/payee` for services that charge, `@agentpay/facilitator` to run a facilitator, `@agentpay/contracts` for the token records. Nothing product-specific lives here; UI, product pages and integration glue belong to the host.

## Wire format

Exactly x402 V2 (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, base64 JSON, everything in the headers), produced and parsed by `@x402/core`. The only additions are outside the protocol: the initial 402 body carries a `payment_model_context` (a hint for an agent that reads it), and the wallet adds `x-agentpay-nonce` / `x-agentpay-ledger-status` to the response it returns so a caller can find the ledger row.

402 (`PAYMENT-REQUIRED` = base64 of):

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "http://127.0.0.1:4021/predict", "description": "ETH-USD prediction", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact", "network": "eip155:31337",
    "amount": "1000", "asset": "0x…usdc", "payTo": "0x…payee", "maxTimeoutSeconds": 60,
    "extra": { "name": "Mock USD Coin", "version": "2", "assetTransferMethod": "eip3009" }
  }]
}
```

`extra.name` / `extra.version` are the token's EIP-712 domain: the payer signs `TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)` under `{ name, version, chainId, verifyingContract: asset }` with `value = amount`, `validBefore = now + maxTimeoutSeconds`, a random 32-byte nonce, and sends it back as `PAYMENT-SIGNATURE` = base64 of `{ x402Version: 2, resource, accepted: <the offer>, payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } } }`. Success: 2xx + `PAYMENT-RESPONSE` = base64 of `{ success: true, transaction: "0x…", network, payer }`. A refusal is a 402 whose `PAYMENT-REQUIRED.error` names the reason (the facilitator's `invalid_exact_evm_*` vocabulary, or the payee's own `replay` / `settlement_unavailable`).

## What each side checks

**Wallet** (`MandateWallet.fetch`): the offer must be `exact` on this wallet's network and token, under the token domain the wallet was *configured* with (the offer's claim is not trusted), with `maxTimeoutSeconds` within `caps.maxAuthorizationValiditySeconds` (default 300: that is how long a failed call's budget stays reserved) → policy gate and budget reservation in one synchronous step → sign → ledger row `in_flight` → send. The settlement report decides the row: `success` + transaction → `settled` (on any HTTP status: "paid but http 500" stays honest), 2xx without a usable report → `unknown` and counted as spent, a refusal → `rejected` with the reservation held until the authorization expires, `settlement_pending` → `unknown` with the transaction. A transport error re-presents the *same* signed header rather than signing again.

**Payee** (`@x402/express` around `createPaywall`): `accepted` must match the route's terms → in-flight claim on `from:nonce` (a concurrent duplicate, on any route, is `replay`) → facilitator `/verify` → run the handler with the response buffered → a handler status ≥ 400 cancels the payment → facilitator `/settle` → `PAYMENT-RESPONSE`, or 402 with the settlement failure. After a settlement the nonce stays refused locally; the chain refuses it anyway.

**Facilitator** (`@x402/evm` exact scheme): scheme, network and `extra.name/version` present → signature recovers to `from` → `to == payTo` → `validBefore ≥ now + 6`, `validAfter ≤ now` → `value == amount` (exact means exact) → the asset is a contract → `eth_call` simulation of `transferWithAuthorization`; on failure, Multicall3 diagnostics name the precise reason (`invalid_exact_evm_insufficient_balance`, `invalid_exact_evm_nonce_already_used`, …). `/settle` simulates again, broadcasts from the facilitator's key, waits for the receipt and checks the `Transfer` event. This repository's facilitator adds an asset allowlist and an optional payee allowlist (it is a public endpoint that pays gas), an optional bearer token, and answers 503 + `Retry-After` when the chain is unreachable instead of the misleading `invalid_exact_evm_signature` the scheme reports on a dead RPC.

**Reconcile** (`MandateWallet.reconcile`): for every `rejected` / `unknown` row, read `authorizationState(payer, nonce)` at one block: used → `settled` (transaction from the `AuthorizationUsed` log); unused at a block whose timestamp is past `validBefore` → `expired-unused`, reservation released (every later block would revert the authorization, so no grace is needed); otherwise still pending. Rows that said `settled` are confirmed once after their validity ended and refunded when the chain never saw the nonce. Judged by chain time, never the wall clock; an RPC serving another chain is refused.

## Budgets (intent mandates)

A human approves an **intent mandate** once — purpose, limit, validity, host allowlist, optional per-call cap and rate — and the agent pays within it with no further prompts. The wallet keeps `spentAmount` and `pendingSpentAmount` per mandate (persisted in `mandates.json`), reserves synchronously *before* signing so concurrent calls cannot overshoot, moves a reservation to spend when the payee reports a settlement, and `reconcile()` settles the rest against the chain. The counters are a cache of the ledger and are rebuilt from it on load, so a crash between the two files heals itself.

The mandate is an EIP-712 credential under the domain `agentpay` / `2`; `parentId` and `holder` are part of the signed struct (empty strings when absent), so a store written under the v1 domain is refused on load with a message that says to archive it and start a fresh home rather than silently re-signed.

**Holders.** A mandate without a `holder` belongs to the *principal* — the top-level agent the user talks to. A delegated one names who may spend it: `session:<id>`, `children:<sessionId>` (every child of that session) or `bot:<id>`. `fetch()` takes a `caller` (`{ kind: 'principal' | 'child' | 'session' | 'bot', id?, parentSession? }`) and first narrows the store to the budgets held for that caller — a child sees what its parent delegated to its children plus what was delegated to it by id — then runs the policy gate over that set only. An empty set is `no_held_mandate` (the principal should request a budget; a child should ask its parent for one); an explicit mandate id outside the set is `holder_mismatch`. The point is that a sub-task never pays from its parent's budget by accident, and the ledger says which session spent what.

**Delegation.** `delegateIntentMandate(parentId, input, holder)` is the only way a child mandate comes to exist. It needs no human step because it can only be narrower than what the human already approved: `limit ≤ effectiveRemaining(parent)`, `validUntil ≤ min(parent.validUntil, now + 24 h)`, every host pattern equal to a parent pattern or a concrete host one of them matches, `perCallMax ≤ the parent's`, the category inherited; it returns the mandate already `signed`. Accounting is **pass-through**: a payment on a child reserves on, and later books to, every mandate on its chain up to the root, so a parent's remaining shrinks with its children's spend and delegating itself reserves nothing (`totals` in `report()` sum the roots only, so nothing is counted twice). What a mandate can actually spend is its **effective remaining** — the smallest remaining on its chain — and that is what `remaining()`, `mandate-list`, `mandate-status` and `report` print; the raw counters stay on the rows. The gate checks every member of the chain (hosts, per-call cap, budget, rate, enabled, window) and a refusal caused by an ancestor carries the usual reason plus `detail.ancestorId`.

**Context.** `fetch()` also takes a `context` — `channel`, `channelName`, `session`, `parentSession`, `origin`, `callId`, `label`, strings of at most 256 chars — copied onto the ledger row, and `report()` adds `byChannel` / `bySession` beside `byHost` / `byResource`. The CLI takes it as `--context k=v` (repeatable) with `AGENTPAY_CONTEXT=k=v,…` as environment defaults, and the caller as `--caller principal | child:<id>@<parentSession> | session:<id> | bot:<id>`.

**Host pre-flight.** `requireMandateHost: true` makes `fetch()` refuse `host_not_allowed` before the first request unless a mandate in the caller's set names the host — for a host that embeds the wallet in a tool table, so an agent cannot use a free-looking `offer` round trip to probe hosts it may never pay.

**The lock.** One wallet process per home: `new MandateWallet({ lock: true })` writes `<home>/wallet.lock` (its pid, refreshed on every save) and releases it in `dispose()`; a second process finds a live pid and refuses to start. A long-lived wallet loads `mandates.json` once and rewrites it from memory, so a CLI write beside it would be silently lost — the CLI's mutating commands (`pay`, `mandate-*`, `reconcile`) therefore refuse a locked home with `error: 'locked'` and the pid, while `mandate-list`, `mandate-status`, `report`, `ledger`, `address`, `balance` and `offer` still read it. `lockedBy(home)` answers the question for anyone else.

## CLI

```bash
AGENTPAY_HOME=$TMPDIR/ap npm run cli -- init --from-deployment localhost --key 0x…
npm run cli -- address                     # where to send USDC (no ETH needed)
npm run cli -- balance
npm run cli -- mandate-create --purpose "market data" --limit 1 --hosts 127.0.0.1
npm run cli -- mandate-delegate --parent <id> --holder children:sess-1 --limit 0.25 --valid-for 3600   # a signed sub-budget inside it
npm run cli -- mandate-list                # every mandate with parentId/holder and its EFFECTIVE remaining
npm run cli -- offer http://127.0.0.1:4021/predict
npm run cli -- pay   http://127.0.0.1:4021/predict     # signs offline; the payee settles
npm run cli -- pay   http://127.0.0.1:4021/predict --caller child:task-7@sess-1 --context session=task-7 --context label="backtest"
npm run cli -- report                      # totals, byHost, byResource, byChannel, bySession, denials
npm run cli -- reconcile
```

`mandate-delegate --parent <id> --holder <session:<id> | children:<sessionId> | bot:<id>> --limit <usd> [--valid-for s --hosts a,b --per-call usd --category c --purpose "…"]` signs the sub-budget in one step (it can only be narrower than the parent; ≤ 24 h). `offer` and `pay` take `--context k=v` (repeatable; keys `channel channelName session parentSession origin callId label`) and `--caller principal | child:<id>@<parentSession> | session:<id> | bot:<id>` (default `principal`: budgets without a holder); `AGENTPAY_CONTEXT=k=v,k=v` supplies context defaults a flag overrides. `pay`, `mandate-*` and `reconcile` refuse a home whose `wallet.lock` names a live process (exit 2, `error: 'locked'`).

Agents use `mandate-request` (creates a draft) and stop until the human runs `mandate-approve <id>`; see [packages/cli/SKILL.md](packages/cli/SKILL.md) for the decision flow an LLM agent should follow, including delegating to child tasks, what `no_held_mandate` / `holder_mismatch` mean, and "run `reconcile` before paying again when an outcome was `unknown`". Config precedence: flags > `AGENTPAY_*` env > `$AGENTPAY_HOME/config.json` > `contracts/deployments/<name>.json` (which supplies the token and its EIP-712 domain).

## Running the pieces yourself (local)

```bash
(cd packages/contracts && npx hardhat node --port 8545)  # terminal 1
npm run deploy:local                                   # MockUSDC + Multicall3; writes packages/contracts/deployments/localhost.json
FACILITATOR_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 npm run facilitator  # terminal 2 (hardhat #3)
npm run payee                                          # terminal 3 (pays to hardhat #2 by default)
curl -i http://127.0.0.1:4021/predict                  # 402 + PAYMENT-REQUIRED
```

Then use the CLI as above with `AGENTPAY_KEY` = hardhat #1 (`0x59c6…690d`). All of these are Hardhat's public dev keys; never use them with real funds. The facilitator refuses to start without ETH, if the token is not EIP-3009, or if the configured domain does not match the token's `eip712Domain()` / `DOMAIN_SEPARATOR()`.

## Base Sepolia

Nothing of this repository is deployed there: `packages/contracts/deployments/base-sepolia.json` is a static record of Circle's testnet USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, domain `USDC` / `2`, checked against `DOMAIN_SEPARATOR()` on chain) and of Coinbase's hosted facilitator.

```bash
DEPLOYMENT=base-sepolia FACILITATOR_URL=https://x402.org/facilitator PAYEE_ADDRESS=0x… npm run payee
DEPLOYMENT=base-sepolia AGENTPAY_KEY=… npm run cli -- init --from-deployment base-sepolia
npm run cli -- address        # send Base Sepolia test USDC here; no ETH needed
npm run cli -- pay http://127.0.0.1:4021/predict
```

To run your own facilitator there instead: `DEPLOYMENT=base-sepolia FACILITATOR_PK=… PAYEES=0x… npm run facilitator` (the key needs Base Sepolia ETH).

Measured on 2026-09-19 against the hosted facilitator (settler `0xd407…f1bf`) and the public `sepolia.base.org` RPC, with a fresh payer holding faucet USDC and no ETH:

- **Sequential paid calls settle in about a second**: 10 in a row, all `200` + `settled`, min 675 ms · median 934 ms · avg 1.0 s · max 1.8 s per call (402 → sign → verify → handler → settle → receipt), against ~50 ms on an automining hardhat node. First settlement: [`0xe833…c9d`](https://sepolia.basescan.org/tx/0xe833ba2f4468695dc6f3c50cd4c154e13e5f114164eb3910d517b9adf2b84c9d), a `transferWithAuthorization` sent by the facilitator, `Transfer(payer → payee, 1000)`, 102 828 gas paid by the facilitator.
- **Parallel calls through the hosted facilitator fail more often than not**: 5 concurrent calls from one payee → 2 settled, 3 answered `402 invalid_exact_evm_transaction_failed` (`replacement transaction underpriced`: the hosted settler reused its own account nonce; once `over rate limit` from the public RPC). Reproduced twice. For those three the handler had already run (settle-after-handler), the payer was not charged, the wallet recorded `rejected`, and `reconcile` released the reservations as `expired-unused` once chain time passed `validBefore`. The self-hosted facilitator serializes its sends (demo scenario 7: 20/20 concurrent), so against the hosted one keep an agent's paid calls sequential, or run your own.
- `balance`, `reconcile` and `report` agree with the chain to the unit: 16 settlements = $0.025 spent, every settled row confirmed through `authorizationState`, every refused one released.

## Differences from the x402 reference setup (deliberate)

1. **A budget in front of the client.** The official client signs whatever it is asked to; `MandateWallet` only signs inside an approved intent mandate, reserves before signing, keeps a ledger and reconciles it. The client's own spend controls are switched off because the gate replaces them.
2. **The wallet pins the token domain.** It refuses offers whose `extra.name/version` differ from its configured domain instead of signing under whatever the offer says.
3. **An in-flight guard on the payee.** The reference middleware lets the same authorization be served twice while its first settlement is pending (on the same or another route with equal terms); `createPaywall` claims `from:nonce` before verifying.
4. **Facilitator hardening.** Allowlists, a bearer token, offline EOA signature checks and honest 503s on RPC outages, plus a send lock so parallel settlements never trip Hardhat's strict nonce ordering.
5. **V2 only, `exact` only, EIP-3009 only.** No V1 headers, no `upto`, no Permit2, no smart-wallet signatures (EIP-1271/6492 are the scheme's, untested here).

## Honest limitations

- **Custody moved to the EOA.** The USDC sits in the payer's own account: whoever holds `AGENTPAY_KEY` / `config.json` can move all of it with one `transfer`, and intent mandates bind the agent, not the key. Keep a small float there and top it up from a cold key; `balance` warns above `caps.floatWarnAtomic`.
- **Settle after the handler means a handler can run and not be paid** (settlement fails after a 2xx: the client gets a 402 and the work was done). This is the x402 `authorization` flow's known cost; a handler that fails is never charged.
- **A refused or lost call keeps its budget reserved until the authorization expires** (`maxTimeoutSeconds`, capped by the wallet); the payee could still settle it in that window. `reconcile()` releases it by chain time.
- **A facilitator that broadcast but timed out** answers `settlement_pending` with the transaction; the payer was probably charged and the payee already answered 402. The wallet records `unknown` and `reconcile()` corrects it. The pending-settlement dedupe is per facilitator process.
- **Self-hosted facilitator on a real network:** the key needs ETH, and there is no replacement logic for a stuck or underpriced transaction (the nonce manager will queue behind it; restart to resync).
- **One wallet process per `AGENTPAY_HOME`**: two processes sharing `mandates.json` can overshoot a limit. The lock (`wallet.lock`, above) turns that into a refusal when the long-lived process asks for it; a process that does not take the lock is not protected, and a stale lock from a pid that died is simply ignored.
- On-chain payments are public; USDC can be frozen by its issuer; MockUSDC has an open mint and exists only for local chains.
