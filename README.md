# Agentic billing

Bill subscriptions, invoices, and metered units over Stripe.

The pack previews each call before it bills. It needs no keys
for a preview. It throws on vendor failure and never hides one.
It stores subscription state in a local ledger or in D1.

## Use cases

- Sell seats to a team. A club bills one subscription per team
and reads status before each renewal.
- Charge per report. A lab meters each report run and bills the
total at the end of the month.
- Invoice a client once. A studio drafts one invoice per job and
finalizes it when the work ships.
- Gate features by plan. A service checks the access policy
before each paid action and points past due accounts at billing.

## Install

```sh
npm install -g agentic-billing
```

Set one key to bill for real:

```sh
export STRIPE_SECRET_KEY=sk_test_xxx
```

Map each plan to a price:

```sh
export BILLING_PRICE_STARTER_MONTHLY=price_xxx
```

## Quick start

Preview a subscription. Preview is the default. It needs no
keys and it spends nothing:

```sh
agentic-billing subscribe --email buyer@example.com \
  --plan starter-monthly
```

Run it for real:

```sh
agentic-billing subscribe --email buyer@example.com \
  --plan starter-monthly --live
```

Read status:

```sh
agentic-billing status --sub sub_xxx --live
```

Report metered units:

```sh
agentic-billing usage --event report_runs \
  --customer cus_xxx --value 3 --live
```

Check access for a status:

```sh
agentic-billing policy --status past_due \
  --grace-days 7 --days-past-due 3
```

## Commands

- `checkout` builds a subscription checkout session.
- `subscribe` creates a subscription for a customer.
- `status` reads a subscription with its access check.
- `cancel` cancels a subscription.
- `invoice` drafts or finalizes a one-off invoice.
- `usage` reports metered units for a customer.
- `portal` builds a customer billing portal link.
- `webhook` verifies a Stripe event and applies it.
- `ledger` lists events or reads one subscription row.
- `policy` checks access for a subscription status.
- `costs` prints the session cost report.
- `mcp` starts the MCP server on stdio.

Every command prints JSON. Every billing command previews
unless you pass `--live`.

## Ledger

The ledger stores subscription state, webhook events, and
usage records. It defaults to a JSON file at
`~/.agentic-billing/ledger.json`. Pass `--ledger-path` to move
it. Pass `--live` with D1 credentials to use D1 instead:

```sh
export CLOUDFLARE_ACCOUNT_ID=xxx
export CLOUDFLARE_API_TOKEN=xxx
export CLOUDFLARE_D1_DATABASE_ID=xxx
```

Recorded event ids stay unique, so a replayed webhook
applies once.

## Webhooks

Point a Stripe endpoint at your server. Hand each raw body to
the pack:

```sh
agentic-billing webhook --file event.json \
  --signature $SIG --secret $WEBHOOK_SECRET
```

The pack checks the signature, plans the ledger writes, and
applies them. It answers `verified` plus the applied ops.
Omit `--signature` to apply a trusted body unverified.
Try it with the sample event:

```sh
agentic-billing webhook --file examples/subscription-event.json \
  --ledger-path /tmp/agentic-billing-ledger.json
agentic-billing ledger --sub sub_example_123 \
  --ledger-path /tmp/agentic-billing-ledger.json
```

## SDK

```js
import {
  createBillingAdapter,
  MemoryLedger,
  reportPackUsage,
  resolvePriceId,
} from "agentic-billing";

const adapter = createBillingAdapter(); // dry run
await adapter.subscribe({
  customerEmail: "buyer@example.com",
  priceId: resolvePriceId("starter-monthly"),
});

const live = createBillingAdapter({
  live: true,
  secretKey: process.env.STRIPE_SECRET_KEY,
});
await live.status("sub_xxx");
```

Sibling packs report per outreach units through one call.
It sends the Stripe meter event, stores the row in the credit
ledger, and records a session cost entry:

```js
await reportPackUsage(adapter, new MemoryLedger(), {
  pack: "agentic-text",
  kind: "sms",
  customerId: "cus_xxx",
  units: 3,
});
```

A dry run previews the Stripe call but still stores the local
ledger row and the cost entry, since both stay local. The
package re-exports the frozen agentic-core API.

## MCP server

Start the server:

```sh
agentic-billing mcp
```

Call `billing_subscribe` for subs, `billing_status` for
status, `billing_usage` for metered units, `billing_invoice`
for invoices, `billing_webhook_plan` for event plans, and
`ledger_events` for ledger reads. Each billing tool previews
by default. Pass `dryRun: false` to run live.

## Config

| Variable | Use |
| --- | --- |
| STRIPE_SECRET_KEY | Live Stripe calls. |
| STRIPE_WEBHOOK_SECRET | Webhook verify default. |
| BILLING_PRICE_* | Plan key to price id map. |
| CLOUDFLARE_ACCOUNT_ID | Live D1 ledger. |
| CLOUDFLARE_API_TOKEN | Live D1 ledger. |
| CLOUDFLARE_D1_DATABASE_ID | Live D1 ledger. |

Test keys start with `sk_test_`. Live keys start with
`sk_live_`. Keep test events out of live ledgers.

## Worker

`src/worker.ts` serves an edge preview: `GET /health`,
`POST /preview`, `POST /access`, `POST /webhook-plan`. It
checks shape and catalog keys and spends nothing. Live calls
run server side.

## License

MIT.
