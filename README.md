# agentpay — authorize first, settle later payments for AI agents

An AEP2-style payment stack (after FluxA's [Agent Embedded Payment Protocol](https://fluxapay.xyz/protocol)): a payer agent signs a one-time **mandate** and embeds it in an HTTP call; the payee verifies it off-chain and serves **immediately**; a **settlement processor** batches many mandates into one on-chain transaction later and debits the payer's pre-funded **debit wallet**. No per-call block wait, sub-cent prices, one budget approval per mission instead of one tap per payment.

Everything here runs end to end on a local Hardhat chain, with deploy scripts for Base Sepolia.

```
 payer agent            payee service              settlement processor (SP)          AEP2DebitWallet (chain)
     │  GET /predict          │                              │                                │
     │───────────────────────>│ 402 + offer (price, SP, …)   │                                │
     │<───────────────────────│                              │                                │
     │  sign Mandate (EIP-712)│                              │                                │
     │  GET /predict + PAYMENT-SIGNATURE                     │                                │
     │───────────────────────>│ verify fields + signature    │                                │
     │                        │ POST /enqueue {mandate,sig}  │                                │
     │                        │─────────────────────────────>│ check authorizedSP, nonce,     │
     │                        │  signed SP receipt           │ debitable balance; reserve     │
     │                        │<─────────────────────────────│                                │
     │  200 + PAYMENT-RESPONSE (receipt)                     │                                │
     │<───────────────────────│                              │   …later, one tx for N mandates│
     │                        │                              │ settleBatch(ms, sigs) ─────────>│ debit payers, pay payees
```

## Quickstart

```bash
npm install
npm test            # every workspace (contract / SP / payee / wallet tests spawn their own hardhat node)
npm run demo        # fresh chain + SP + payee + agent, 7 scenarios, exit 0 iff all pass
```

The demo prints, among other things: a paid call with the on-chain balance **unchanged** (settlement is deferred), a budget refusal *before* anything is signed, a 409 on replay, the SP refusing an unauthorized or unfunded payer, 20 calls settled by **one** `settleBatch` transaction, and a withdrawal that stays locked until the in-flight mandate has been settled.

## Packages

| workspace | what it is |
|---|---|
| `packages/core` | Types, x402-shaped wire format, EIP-712 mandate + SP-receipt helpers, money parsing, error taxonomy, `payment_model_context` hints for LLM agents |
| `packages/contracts` | `AEP2DebitWallet.sol` (deposit, per-payer SP authorization, delayed withdrawals, `settle` / `settleBatch`), `MockUSDC.sol`, deploy scripts, generated ABI |
| `packages/sp` | Settlement processor: `POST /enqueue` validation + reservation + signed receipt, JSONL queue, batching worker (`node:http`, zero deps) |
| `packages/payee` | `createMandatePaywall()` express-style middleware: 402 offers, mandate verification, replay protection, SP enqueue, `PAYMENT-RESPONSE` |
| `packages/wallet` | `MandateWallet`: intent mandates (user-approved budgets), policy gate before signing, `fetch()` that answers 402s, ledger, `reconcile()`, `report()` |
| `packages/cli` | `agentpay` CLI (JSON out, exit codes) + `SKILL.md` for LLM agents |
| `demo` | One-command end-to-end scenario runner and its test |

## Using it as a submodule (e.g. inside Kairos)

This repository is a component, not a host: the product that pays (Kairos) keeps its own repository and pulls this one in as a git submodule.

```bash
git submodule add https://github.com/linqizhe07/agentpay modules/payment   # in the host repo
git submodule update --init
(cd modules/payment && npm install)
```

The host then imports the SDK packages by path or workspace: `@agentpay/wallet` for the paying agent, `@agentpay/payee` for services that charge, `@agentpay/sp` to run a settlement processor, `@agentpay/contracts` for the ABI and deploy helpers. Nothing product-specific lives here; UI, product pages and integration glue belong to the host.

## Wire format

The mandate rides in an **x402 V2-shaped envelope** with scheme `aep2`, so it is "embedded in the x402 call"; FluxA's bare `X-Payment-Mandate` header is accepted on read for compatibility.

402 (header `PAYMENT-REQUIRED` = base64 of the same JSON as the body):

```json
{
  "x402Version": 2,
  "error": "mandate_required",
  "accepts": [{
    "scheme": "aep2", "network": "eip155:31337",
    "amount": "1000", "asset": "0x…usdc", "payTo": "0x…payee",
    "resource": "GET /predict", "maxTimeoutSeconds": 60,
    "extra": { "wallet": "0x…debitWallet", "sp": "http://127.0.0.1:3001", "spAddress": "0x…sp", "settleWindowSeconds": 10800 }
  }],
  "payment_model_context": { "protocol": "aep2", "reason": "mandate_required", "summary": "…", "remediation": ["…"] }
}
```

Retry with header `PAYMENT-SIGNATURE` = base64 of:

```json
{ "x402Version": 2, "accepted": { …the offer… },
  "payload": { "mandate": { "owner", "token", "payee", "amount": "1000", "nonce": "<uint256>", "deadline": 1760000000, "ref": "0x…" }, "payerSig": "0x…" } }
```

`Mandate(address owner,address token,address payee,uint256 amount,uint256 nonce,uint64 deadline,bytes32 ref)` is signed under the EIP-712 domain `{ name: "AEP2DebitWallet", version: "1", chainId, verifyingContract: <wallet> }`; `ref = keccak256("METHOD /path")` (or `"METHOD /path#quoteId"`). Signatures must be canonical 65-byte `(r, s, v)` with low `s` and `v ∈ {27, 28}`: the off-chain verifiers (payee, SP) reject anything else so that they accept exactly what the contract's ECDSA accepts — otherwise a payer could present a malleated copy of its own signature, get served, and never be debited.

Success: 2xx + header `PAYMENT-RESPONSE` = base64 of `{ success: true, scheme: "aep2", network, payer, transaction: "", status: "enqueued", mandateDigest, spReceipt: { sp, mandateDigest, enqueueDeadline, spEnqueueSig } }`. The body is untouched (set `includeBodyPaymentField: true` to add FluxA's in-body `payment` field to JSON responses). Refusals: 402 with the offer and `error: "<reason>"`, 409 `{ error: "replay" }`.

The SP receipt is EIP-712 `SPReceipt(bytes32 mandateDigest,uint64 enqueueDeadline)` under `{ name: "AEP2SettlementProcessor", version: "1", chainId, verifyingContract: <wallet> }` — a signed promise to settle by `enqueueDeadline`.

## What each side checks

**Payee** (`createMandatePaywall`): decode header → echoed offer matches (x402 envelope only) → `payee == payTo`, `token == asset`, `amount ≥ price`, `deadline` not expired and ≥ `now + settleWindowSeconds`, `ref` binds this resource → signature recovers to `owner` → idempotency claim on the mandate digest (409 `replay`) → optional on-chain pre-check (`debitableBalance`, `usedNonces`) → `POST <sp>/enqueue` and verify the receipt → run the handler.

**Settlement processor** (`POST /enqueue`): schema → chain/token supported → amounts → deadline window → signature → idempotent replay of a known digest returns the original receipt with `created: false` and its `enqueuedAt` → local nonce index → on-chain `authorizedSP(owner, sp)`, `usedNonces`, `debitableBalance`, all read at one block that is not behind the SP's last settlement (a lagging replica gets a 503) → `debitable ≥ amount + reserved(owner, token)` → reserve, persist, sign receipt with `enqueueDeadline = min(mandate.deadline, now + settleWindow)`. The worker never lets an RPC outage turn a receipted mandate terminal: transport failures back off without counting as attempts, and only the mandate's deadline can expire it. A `NonceUsed` skip is reported as `settled` only when a `Settled` event for that exact digest exists on-chain (a nonce consumed by a *different* mandate is `failed: nonce_used`).

**Contract** (`settle` / `settleBatch`, callable by anyone but effective only for payers who `authorizeSP`'d the caller): params → `authorizedSP[owner][msg.sender]` → deadline → nonce unused → **full** balance ≥ amount → ECDSA recovery → mark nonce, debit, pay the payee. In `settleBatch` a failing item is skipped and reported via `SettleSkipped(digest, owner, nonce, status)` instead of reverting the batch.

**Withdrawal safety**: `requestWithdraw` starts a timer (`withdrawDelay` ≥ every SP's settle window). During the delay the SP can still settle against the full balance; `executeWithdraw` then pays out only what is left. `debitableBalance = balance − pending withdrawal` is what SPs admit *new* mandates against, so a mandate is never accepted against money already on its way out. This gives the same guarantee as FluxA's "auto-extending" withdrawal timer without a timer.

## Budgets (intent mandates)

A human approves an **intent mandate** once — purpose, limit, validity, host allowlist, optional per-call cap and rate — and the agent pays within it with no further prompts. The wallet keeps `spentAmount` and `pendingSpentAmount` per mandate (persisted in `mandates.json`), reserves synchronously *before* signing so concurrent calls cannot overshoot, moves a reservation to spend as soon as the SP accepts the mandate (an enqueued mandate is irrevocable for the payer), and `reconcile()` confirms settlements on-chain, releases expired reservations, and flags an SP that broke its receipt.

Deadline policy: the wallet signs `deadline = now + settleWindowSeconds + max(offer.maxTimeoutSeconds, 60)` (capped by `maxMandateValiditySeconds`), the payee refuses deadlines shorter than the settle window, the SP refuses deadlines closer than `MIN_DEADLINE_MARGIN` or further than `MAX_DEADLINE_HORIZON`, and everyone verifies `enqueueDeadline ≤ mandate.deadline`.

## CLI

```bash
AGENTPAY_HOME=$TMPDIR/ap npm run cli -- init --from-deployment localhost --key 0x…
npm run cli -- deposit 5
npm run cli -- sp-authorize 0x…sp
npm run cli -- mandate-create --purpose "market data" --limit 1 --hosts 127.0.0.1
npm run cli -- offer http://127.0.0.1:4021/predict
npm run cli -- pay   http://127.0.0.1:4021/predict
npm run cli -- report
```

Agents use `mandate-request` (creates a draft) and stop until the human runs `mandate-approve <id>`; see [packages/cli/SKILL.md](packages/cli/SKILL.md) for the decision flow an LLM agent should follow. Config precedence: flags > `AGENTPAY_*` env > `$AGENTPAY_HOME/config.json` > `contracts/deployments/<name>.json`.

## Running the pieces yourself (local)

```bash
(cd packages/contracts && npx hardhat node --port 8545)  # terminal 1
npm run deploy:local                                   # writes packages/contracts/deployments/localhost.json
SP_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 npm run sp        # terminal 2 (hardhat #3)
PAYEE_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a npm run payee  # terminal 3 (hardhat #2)
curl -i http://127.0.0.1:4021/predict                  # 402 + PAYMENT-REQUIRED
```

Then use the CLI as above with `AGENTPAY_KEY` = hardhat #1 (`0x59c6…690d`). All of these are Hardhat's public dev keys; never use them with real funds.

## Base Sepolia

```bash
cp .env.example .env            # fill DEPLOYER_PK (funded with Base Sepolia ETH), SP_PK
npm run deploy:base-sepolia     # deploys AEP2DebitWallet against Circle's testnet USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e
DEPLOYMENT=base-sepolia npm run sp
DEPLOYMENT=base-sepolia PAYEE_PK=… npm run payee
DEPLOYMENT=base-sepolia AGENTPAY_KEY=… npm run cli -- deposit 1     # needs test USDC in the payer EOA
```

## Differences from FluxA (deliberate)

1. `deadline` is `uint64` and `usedNonces` is keyed `(owner, nonce)` (FluxA: `uint256` and `(owner, token, nonce)`), so signatures are not interchangeable with FluxA's deployed contract.
2. SP receipts are EIP-712 typed data (FluxA: `personal_sign` over packed bytes).
3. **Security fix** — `settle` checks the payer's *full* balance, not the balance minus a pending withdrawal. In FluxA's reference contract `requestWithdraw` debits immediately, so a payer could get served, request a withdrawal of everything, and starve settlement.
4. **Security fix** — settlement processors are authorized by each payer (`authorizeSP`), as FluxA's docs describe, instead of a contract-wide `setSP` by the deployer. The contract has no admin.
5. No ZK batch proof: `settleBatch` verifies each signature on-chain (the demo measures ~43k gas per mandate in a batch of 24 on Hardhat). Batching still amortizes the transaction overhead; a proof-based aggregator could replace the loop without changing the wire format.

## Honest limitations

- MVP, unaudited. `MockUSDC` is a test token with open mint; `AEP2DebitWallet` has no fee logic, no upgradeability, no pause.
- The SP is a single process with a JSONL store; the payee's idempotency store is in-memory (swap `IdempotencyStore` for Redis in multi-instance deployments). Across a payee restart, a replayed mandate is caught through the SP's `created: false` answer only once it is older than 60 s (`REPLAY_GRACE_SECONDS`); inside that window a re-presented mandate is treated as the payee's own retry after an SP timeout.
- The wallet's budget store (`mandates.json`) is single-writer: it is loaded once per `MandateWallet` and rewritten whole on save, so two processes sharing one `AGENTPAY_HOME` (two concurrent `agentpay pay` runs, or an agent process plus the CLI) can overwrite each other's counters and overshoot a limit. Run one wallet process per home directory, or put a lock around it before multi-process use.
- No KYC/KYB/KYA provider, no dispute processor, no payment links, cards, marketplace, or UI — FluxA's surfaces beyond the core protocol are out of scope here.
- Trust model: the payee trusts the SP's receipt (the SP could fail to settle; `reconcile()` detects that as `spDefaults`, nothing enforces it on-chain yet), and the payer trusts the payee to deliver (no delivery receipt or recourse in AEP2).
