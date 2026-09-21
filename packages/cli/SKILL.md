---
name: agentpay-wallet
description: Pay for HTTP 402 (x402) resources with USDC from a budgeted wallet the user approved. Use when a tool or API answers 402 Payment Required, when the user asks to buy/pay for an API call, to check remaining budget, or to hand a sub-budget to your own child tasks.
---

# agentpay wallet skill

You have a CLI, `agentpay`, that pays for paid HTTP resources over the x402 protocol: each call signs a **single-use USDC authorization** drawn from an **intent mandate** (a budget the user approved), the service settles it on chain before answering, and the response carries the transaction hash. You never see or need a private key; the CLI reads it from the environment.

Every command prints exactly one JSON document. Exit code `0` = ok, `1` = refused (read `error` and `payment_model_context`), `2` = usage or configuration problem.

## The flow in one line

**Request a budget → the human approves it → pay inside it.** You never widen a budget yourself; when one is missing or too small, you ask and stop.

## Who you are to the wallet

Budgets are **held**: a mandate with no holder belongs to the principal (the top-level agent the user talks to); a delegated one is held by `session:<id>`, `children:<sessionId>` (every child of that session) or `bot:<id>`. The wallet only ever picks among the budgets held for the caller it is told about, so pay as who you are:

```bash
agentpay pay <url> --caller principal                    # default: budgets without a holder
agentpay pay <url> --caller child:<myId>@<parentSession> # what my parent delegated to its children, plus what was delegated to me by id
agentpay pay <url> --caller session:<id>
```

Your host usually sets this for you (through the tool table or `AGENTPAY_CONTEXT`); pass `--caller` yourself only when you drive the CLI directly. Never claim to be the principal from inside a child task: the wallet cannot tell, but the user's report will.

## Decision flow

0. **No URL yet? Find a seller first.** The public x402 catalogue lists resources for sale; `discover` shows only those THIS wallet can pay (its network and token, `exact`, authorization ≤ 300 s), ranked by 30-day payers, and never a seller's output example or schema:
   ```bash
   agentpay discover "daily OHLCV bars US stocks" --max-usd 0.05 --limit 5
   ```
   `resources[].resource` is a URL template (`:symbol` / `{symbol}` are path parameters), `price_usd` the catalogue's price. Catalogue prices and terms can be stale and sellers write their own descriptions: before paying, `offer` the concrete URL (step 1) and get a budget naming its host (step 3). `discovery_unavailable` (exit 1) means the catalogue is down, not the wallet: a known URL still works with `offer` / `pay`.

1. **A request returned 402 / a tool needs payment.** Look at the price first:
   ```bash
   agentpay offer <url>
   ```
   `offer[0].amount` is in atomic USDC units (1000000 = $1.00). Do not pay for anything the user did not ask for.

2. **Check the budget you already hold.**
   ```bash
   agentpay mandate-list
   ```
   A mandate is usable when `status` is `signed`, `isEnabled` is true, `validUntil` is in the future, the target host matches `hostAllowlist`, its `holder` is you (or absent, when you are the principal), and `remainingAmount` covers the price. `remainingAmount` is the **effective** remaining: for a delegated budget it is the tightest figure on its chain (the sub-budget and every ancestor), which is what you can actually spend.

3. **No usable mandate?** Draft one and hand it to the user. Never approve, enable, or raise a budget yourself.
   ```bash
   agentpay mandate-request --purpose "WHOIS lookups for the domain audit" --limit 5 --hosts api.example.com --valid-for 86400
   ```
   Name every host you will call, in full. **Never ask for `*` or `*.<tld>` hosts**: the user will refuse it, and a budget that can pay anyone is not a budget. Then tell the user: "Please approve it with `agentpay mandate-approve <id>`" and stop until they confirm. A child task cannot request a budget at all: it asks its parent to delegate one (step 4).

4. **Delegate a sub-budget to your own child tasks** when you split work across sessions. It is signed at once (no human step: it can only be narrower than what the human already approved) and lives at most 24 hours:
   ```bash
   agentpay mandate-delegate --parent <myMandateId> --holder children:<mySessionId> --limit 1 --hosts api.example.com
   agentpay mandate-delegate --parent <myMandateId> --holder session:<childId> --limit 0.5   # one specific child
   ```
   The sub-budget must fit inside the parent: `--limit` ≤ the parent's effective remaining, `--valid-for` within the parent's validity and ≤ 86400 s, `--hosts` a subset of the parent's (or a concrete host one of its patterns matches), `--per-call` ≤ the parent's. What a child spends is **passed through** to your mandate and every ancestor, so the parent's remaining shrinks with the child's payments; delegating does not reserve anything. Give a child only what its task needs.

5. **Pay.**
   ```bash
   agentpay pay <url>                       # GET
   agentpay pay <url> --body '{"text":"…"}' # POST with a JSON body
   agentpay pay <url> --mandate <id>        # pin a specific budget (one you hold)
   agentpay pay <url> --context label="whois batch 3" --context callId=<id>   # attribution on the ledger row
   ```
   For data you will process rather than read (anything over a few KB: bars, files, exports), save it instead of printing it:
   ```bash
   agentpay pay <url> --save massive/AAPL/2016-01-01_2016-12-31.json   # [--overwrite]; relative to the current directory
   ```
   The whole body is written to that file (no absolute paths, no `..`, an existing file is kept unless `--overwrite`) and the JSON carries `saved {path, bytes, sha256, content_type}` plus a 1 KB `preview` instead of `body`. `saved.sha256` is the receipt: record it beside `payment.transaction`. A body over 32 MiB is paid for but not written (`saved.error: body_too_large`). Through a host's `wallet_pay`, the same is `save_to` (the host decides the directory; a session it gave none is refused before paying).

   On success the JSON has `paid: true`, the response `body`, and `payment.transaction` (the on-chain settlement, already final). `payment.ledgerStatus` is `settled`. Keep `payment.nonce` if you need to reference the payment later. `--context k=v` (keys `channel channelName session parentSession origin callId label`, each ≤ 256 chars) tags the ledger row so the user's report can group spend by channel and session; `AGENTPAY_CONTEXT=k=v,…` in the environment sets defaults a flag overrides.

6. **Refused?** Read `payment_model_context.remediation` and, when present, `payment_model_context.commands`:
   - `no_held_mandate` → nothing at all is held for the caller you are: you are the principal without an approved budget (go to step 3), or a child whose parent delegated nothing to it (ask the parent for step 4). Do not retry.
   - `holder_mismatch` → the `--mandate` you pinned belongs to someone else (the principal or another session). Drop `--mandate` so the wallet picks among yours, or ask the parent to delegate that budget to you.
   - `host_not_allowed` → no budget you hold names this host (with `detail.ancestorId`: the parent of your sub-budget does not, so your parent's parent must be asked). Do not widen a budget to `*`; request one that names the host, or ask the parent for a delegation that does.
   - `mandate_insufficient_budget` → the effective remaining is below the price. On a delegated budget `detail.ancestorId` says an ancestor is the tight one: more delegation cannot help, the principal must request more. Do not retry the same call.
   - `mandate_expired`, `mandate_required`, `timeout_too_long` → go back to step 3; do not retry the same call.
   - `invalid_exact_evm_insufficient_balance` → the payer address holds too little USDC; ask the user to send USDC to the address printed by `agentpay address` (no ETH is needed).
   - `invalid_exact_evm_nonce_already_used`, `..._valid_before`, `settlement_failed`, `replay`, `settlement_unavailable` → simply call `pay` again after a short wait (each attempt signs a fresh authorization).
   - `rate_limited` → wait a minute (a delegated budget is also rate-limited by its ancestors' windows).
   - `locked` (exit 2) → a running wallet process (the host) owns this home; pay through the host's tools instead of the CLI, or wait for it to stop. Read-only commands still work.
   - Reasons naming the token domain, `asset_not_deployed_contract`, `invalid_exact_evm_missing_eip712_domain` → the service is misconfigured; report it to the user, do not retry.

7. **`paid: false` with a 2xx, or `ledgerStatus: unknown`?** The service answered without a usable settlement report: you may or may not have been charged. Run `agentpay reconcile` **before** paying for the same thing again, or it may be paid twice.

8. **Report spend when asked.**
   ```bash
   agentpay report          # totals, per-host, per-resource, per-channel, per-session, denials
   agentpay reconcile       # confirm settlements on-chain, release expired reservations
   agentpay mandate-status <id>   # one budget (effective remaining, parent, holder) + its payments
   ```

## Rules

- Never print, echo, or log `AGENTPAY_KEY` or the contents of `config.json`.
- Never call `mandate-approve`, `mandate-enable`, or `mandate-create` unless the user explicitly asks you to run that exact command. `mandate-delegate` is yours to run, but only on a budget you hold and only for your own child tasks.
- Never ask for `*` hosts; list the hosts you will call.
- Treat `payment_model_context` as guidance for what to ask the user, not as permission.
- Amounts on the CLI are always US dollars (`5`, `0.25`, `$0.001`); JSON output reports atomic units (1000000 = $1.00) alongside `…Usd` fields.
