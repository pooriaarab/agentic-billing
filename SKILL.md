---
name: agentic-billing
description: Bill subscriptions, invoices, and metered units over Stripe. Keywords: stripe, subscriptions, invoicing, agentic-suite, claude-code, codex, cli, mcp.
---

# agentic-billing

Bill subscriptions, invoices, and metered units over Stripe.

## Use the SDK

```js
import { createBillingAdapter, resolvePriceId } from "agentic-billing";

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

Sibling packs report per outreach units through one call:

```js
import { MemoryLedger, reportPackUsage } from "agentic-billing";

await reportPackUsage(adapter, new MemoryLedger(), {
  pack: "agentic-text",
  kind: "sms",
  customerId: "cus_xxx",
  units: 3,
});
```

## Use the CLI

```sh
agentic-billing subscribe --email buyer@example.com --plan starter-monthly
agentic-billing subscribe --email buyer@example.com --plan starter-monthly --live
agentic-billing usage --event report_runs --customer cus_xxx --value 3 --live
```

## Use the MCP server

Start the server with `agentic-billing mcp`. Call
`billing_subscribe` for subs, `billing_status` for status,
`billing_usage` for metered units, `billing_invoice` for
invoices, `billing_webhook_plan` for event plans,
`ledger_events` for ledger reads, `get_cost_report` for costs.

## Rules

- Preview each call with dry run first.
- Run live only when asked.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
