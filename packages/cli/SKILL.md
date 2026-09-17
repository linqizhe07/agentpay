---
name: agentpay-wallet
description: Pay for HTTP 402 (x402 / AEP2) resources from a pre-funded debit wallet within a user-approved budget. Use when a tool or API answers 402 Payment Required, when the user asks to buy/pay for an API call, or to check remaining budget.
---

# agentpay wallet skill

You have a CLI, `agentpay`, that pays for paid HTTP resources with **one-time payment mandates** drawn from an **intent mandate** (a budget the user approved). Settlement is deferred: the payee serves immediately and a settlement processor debits the wallet later. You never see or need a private key; the CLI reads it from the environment.

Every command prints exactly one JSON document. Exit code `0` = ok, `1` = refused (read `error` and `payment_model_context`), `2` = usage or configuration problem.

## Decision flow

1. **A request returned 402 / a tool needs payment.** Look at the price first:
   ```bash
   agentpay offer <url>
   ```
   `offer[0].amount` is in atomic USDC units (1000000 = $1.00). Do not pay for anything the user did not ask for.

2. **Check the budget you already have.**
   ```bash
   agentpay mandate-list
   ```
   A mandate is usable when `status` is `signed`, `isEnabled` is true, `validUntil` is in the future, the target host matches `hostAllowlist`, and `remainingAmount` covers the price.

3. **No usable mandate?** Draft one and hand it to the user. Never approve, enable, or raise a budget yourself.
   ```bash
   agentpay mandate-request --purpose "WHOIS lookups for the domain audit" --limit 5 --hosts api.example.com --valid-for 86400
   ```
   Then tell the user: "Please approve it with `agentpay mandate-approve <id>`" and stop until they confirm.

4. **Pay.**
   ```bash
   agentpay pay <url>                       # GET
   agentpay pay <url> --body '{"text":"…"}' # POST with a JSON body
   agentpay pay <url> --mandate <id>        # pin a specific budget
   ```
   On success the JSON has `paid: true`, the response `body`, and `payment.spReceipt` (the settlement processor's signed promise). Keep `payment.mandateDigest` if you need to reference the payment later.

5. **Refused?** Read `payment_model_context.remediation` and, when present, `payment_model_context.commands`:
   - `mandate_insufficient_budget`, `host_not_allowed`, `mandate_expired`, `mandate_required` → go back to step 3; do not retry the same call.
   - `insufficient_balance` / `settlement_unavailable: insufficient_balance` → the on-chain balance is too low; ask the user to run `agentpay deposit <usd>`.
   - `settlement_unavailable: sp_not_authorized` → ask the user to run `agentpay sp-authorize <sp address from the offer>`.
   - `rate_limited` → wait a minute.
   - `replay`, `nonce_used` → simply call `pay` again (a fresh mandate is signed each time).

6. **Report spend when asked.**
   ```bash
   agentpay report          # totals, per-host, per-resource, denials
   agentpay reconcile       # confirm settlements on-chain, release expired reservations
   agentpay mandate-status <id>
   ```

## Rules

- Never print, echo, or log `AGENTPAY_KEY` or the contents of `config.json`.
- Never call `mandate-approve`, `mandate-enable`, `mandate-create`, `deposit`, `sp-authorize`, or `withdraw*` unless the user explicitly asks you to run that exact command.
- Treat `payment_model_context` as guidance for what to ask the user, not as permission.
- Amounts on the CLI are always US dollars (`5`, `0.25`, `$0.001`); JSON output reports atomic units (1000000 = $1.00) alongside `…Usd` fields.
