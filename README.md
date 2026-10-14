# agentic-billing

[![npm version](https://img.shields.io/npm/v/agentic-billing)](https://www.npmjs.com/package/agentic-billing) [![Downloads/month](https://img.shields.io/npm/dm/agentic-billing)](https://www.npmjs.com/package/agentic-billing) [![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-billing) · [Setup](#integration-guides) · [API](#runtime-surfaces) · [Support](https://github.com/pooriaarab/agentic-billing/issues)

agentic-billing is an open-source Stripe billing toolkit for developers and agents. It previews subscriptions, checkout sessions, invoices, usage events, and customer portal links. A JavaScript SDK, command-line interface (CLI), and Model Context Protocol (MCP) server expose the billing operations.

## Install

```sh
npm install agentic-billing
```

Use Node.js 18 or later. TypeScript declarations are included. The package has four direct runtime dependencies, including the Stripe SDK.

## Preview your first subscription

No credentials or environment variables are required for this preview.

```sh
npx agentic-billing subscribe --email buyer@example.com --price price_example
```

The JSON result contains `dryRun: true`, `status: "active"`, and a deterministic `subscriptionId` with the `sub_` prefix.
No Stripe subscription is created. The status is a simulated result.

```js
import { createBillingAdapter } from 'agentic-billing';

const adapter = createBillingAdapter();
const result = await adapter.subscribe({
  customerEmail: 'buyer@example.com', priceId: 'price_example',
});
console.log(result.dryRun, result.status, result.subscriptionId);
```

## How it works

```text
SDK / CLI / MCP → billing adapter → dry preview or Stripe SDK → result
Verified webhook body → event plan → caller applies ledger operations
                                    ├─ memory / optional JSON file
                                    └─ Cloudflare D1 REST API
Subscription status → access policy → allow / warn / deny
```

## Why it exists

Stripe Billing and Chargebee provide billing APIs and account tools.
agentic-billing exposes selected Stripe operations through previewable commands and agent tools.
It also supplies webhook plans and a small ledger interface for application subscription state.

## Compare

Checked 2026-10-14 against source and the linked API documentation.

| Scope | agentic-billing | [Stripe Billing](https://docs.stripe.com/billing/subscriptions/overview) | [Chargebee](https://apidocs.chargebee.com/docs/api/subscriptions) |
| --- | --- | --- | --- |
| Role | Toolkit over Stripe | Billing provider | Subscription billing service |
| Execution | Your Node.js process | Remote Stripe API | Remote Chargebee API |
| Configuration | Stripe key, price IDs, optional D1 credentials | Stripe account and API parameters | Chargebee site and API parameters |
| Result scope | Selected billing fields and local policy | Native Stripe resources | Native Chargebee resources |

## Coverage

The code implements seven billing operations through Stripe and a matching dry-run adapter.
It includes two ledger backends: memory with optional file persistence, and Cloudflare D1.

| Integration / mode | Status | Scope |
| --- | --- | --- |
| Stripe | SDK adapter; credential verification pending | Checkout, subscribe, status, cancel, invoice, usage, portal |
| Cloudflare D1 | REST adapter; credential verification pending | Events, subscriptions, usage ledger |
| Dry-run billing | Offline preview | Simulated billing results |
| Memory / JSON file ledger | Local implementation | In-memory state with explicit file load/save |

No Stripe or Cloudflare credentials were used for this review. Tests use mocked provider clients and HTTP responses.

The webhook planner handles eight event types:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `invoice.paid`
- `invoice.payment_failed`

## Common use cases

1. **Stripe SaaS developers:** preview a seat quantity before creating a subscription checkout session.
2. **Node.js tool builders:** report customer usage to an existing Stripe meter.
3. **Stripe service businesses:** create an invoice item, then draft or finalize its invoice.
4. **Cloudflare D1 users:** store webhook event IDs and selected subscription state in a ledger.
5. **MCP client developers:** inspect billing previews and apply an explicit webhook plan through ledger tools.

## Features

- **Billing previews:** return simulated results without Stripe requests by default.
- **Price catalog:** map plan names to `BILLING_PRICE_*` variables or accept Stripe price IDs directly.
- **Access policy:** return allow for active/trialing, warn within a past-due grace window, and deny other states.
- **Webhook signatures:** verify raw body signatures with a five-minute default tolerance.
- **Event ledger:** detect repeated event IDs and store selected subscription fields.
- **Pack usage:** send a meter event, store a usage row, and record process-local units with `reportPackUsage`.

## Runtime surfaces

Use `createBillingAdapter()` for previews or `billingAdapterForEnv(env, true)` for provider calls.
Adapter methods are `checkout`, `subscribe`, `status`, `cancel`, `invoice`, `usage`, and `portal`.
The SDK also exports billing validation, access policy, webhook parsing/planning, memory/file and D1 ledgers, and core utilities.

| CLI command | Purpose |
| --- | --- |
| `checkout` | Create a subscription checkout session |
| `subscribe` | Create a subscription; create a customer when only email is supplied |
| `status` | Read a subscription and its access decision |
| `cancel` | Cancel immediately |
| `invoice` | Draft or finalize a one-off invoice |
| `usage` | Send a meter event |
| `portal` | Create a customer portal session |
| `webhook` | Parse or verify an event and apply its ledger plan |
| `ledger` | List recent events or read a subscription row |
| `policy` | Check access for a supplied status |
| `costs` | Print process-local cost units |
| `mcp` | Start the stdio server |

Help uses no arguments, `--help`, or `-h`. Version uses `--version` or `-V`.
Literal `help` and `version` commands are not accepted.

MCP exposes fourteen tools:
`billing_checkout`, `billing_subscribe`, `billing_status`, `billing_cancel`, `billing_invoice`, `billing_usage`, `billing_portal`,
`billing_webhook_plan`, `ledger_record_event`, `ledger_upsert_subscription`, `ledger_events`, `ledger_subscription`, `billing_policy`, and `get_cost_report`.
Billing tools preview by default. `dryRun: false` selects Stripe calls; ledger tools use `live: true` to select D1.

```json
{"mcpServers":{"agentic-billing":{"command":"npx","args":["agentic-billing","mcp"]}}}
```

The self-hosted Worker source serves `GET /health`, `POST /preview`, `POST /access`, and `POST /webhook-plan`.
It calculates previews and plans; it does not execute billing or ledger writes.

## Delivery and behavior limits

`--live` selects provider calls, including Stripe test-mode calls with a test key.
The package does not collect payment details itself. Configure payment methods, prices, meters, and portal settings in Stripe.
Subscription creation does not prove payment succeeded. Inspect the returned status and later verified events.
Cancellation is immediate; the adapter does not expose cancellation at period end.
Invoice calls finalize by default; pass `--draft` to retain a draft.
Multi-step customer/subscription and invoice calls are not atomic. A later failure can leave an earlier resource created.
The wrapper does not pass request idempotency keys for checkout, subscribe, or invoice creation.
Usage accepts an optional meter event identifier. Choose stable identifiers for repeated logical usage reports.
The ledger and Stripe requests do not form one transaction.
CLI webhook processing records an event before the subscription update. A partial failure can leave an event recorded without its update.
Repeated recorded event IDs stop later CLI plan operations, so this is not an exactly-once recovery system.
The code does not enforce separation between test and live events. Use separate ledgers and validate event mode yourself.
CLI webhook calls without a signature accept an unverified body, even with `--live`.
The planner and Worker webhook-plan route do not verify signatures.
Ledger tools can write local files without Stripe live mode. CLI webhook processing also writes locally by default.
`reportPackUsage` records local ledger state and cost units even with a dry-run billing adapter.
Repeated usage calls can add repeated cost entries despite ledger identifier reuse.
Cost reports hold units in process memory, not Stripe billing amounts or persistent spending totals.
D1 calls have a ten-second default timeout and no wrapper retry loop. Stripe request behavior follows the installed Stripe SDK.
Core guard helpers are exported, but billing methods do not automatically enforce them.

## Integration guides

Export credentials through your shell or secret store. The package does not automatically load `.env` files.

| Variable | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe API calls; use a test key for test resources |
| `STRIPE_WEBHOOK_SECRET` | CLI signature verification default |
| `BILLING_PRICE_STARTER_MONTHLY` | Example plan mapping for `starter-monthly` |
| `CLOUDFLARE_ACCOUNT_ID` | D1 account |
| `CLOUDFLARE_API_TOKEN` | D1 REST API token |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 database |

Preview first. After authorizing a provider call, use a real test price and key:

```sh
export STRIPE_SECRET_KEY='sk_test_your_key'
export BILLING_PRICE_STARTER_MONTHLY='price_your_test_price'
npx agentic-billing checkout --plan starter-monthly --success-url https://example.com/success --cancel-url https://example.com/cancel
npx agentic-billing checkout --plan starter-monthly --success-url https://example.com/success --cancel-url https://example.com/cancel --live
```

The second result contains `dryRun: false`, a Stripe session ID, and its checkout URL.
Confirm the session in your Stripe test environment.

The local CLI ledger defaults to `~/.agentic-billing/ledger.json` for webhook and ledger commands.
Use `--ledger-path` to choose a separate file. `--live` selects D1 for those commands.
Verify external webhook signatures before applying plans:

```sh
npx agentic-billing webhook --file event.json --signature "$SIG" --ledger-path /tmp/billing-test-ledger.json
```

Set `SIG` to the received Stripe-Signature header and configure `STRIPE_WEBHOOK_SECRET`.
The result reports `verified: true`, the plan, and applied operations.
MCP planning returns operations only; callers must apply ledger writes explicitly.

- [Stripe subscription lifecycle and status reference](https://docs.stripe.com/billing/subscriptions/overview)
- [Stripe webhook setup and signature verification](https://docs.stripe.com/webhooks)
- [Cloudflare D1 database setup](https://developers.cloudflare.com/d1/)

## Status

Version 0.1.0 is an early release. Interfaces and ledger behavior can change before 1.0.
[Report bugs or request support](https://github.com/pooriaarab/agentic-billing/issues).
Public case studies are not yet published in this repository.
Contributors can run `npm run build`, `npm run typecheck`, and `npm test`.

## FAQ

### What is agentic-billing?

agentic-billing wraps selected Stripe billing operations with previews, CLI commands, and MCP tools. It also exports ledger and access-policy utilities.

### Which integrations are verified?

agentic-billing implements Stripe and Cloudflare D1 adapters. Mocked tests verify their behavior; live credential checks remain pending for this review.

### Does agentic-billing provide managed billing?

agentic-billing runs in your own process. Stripe handles provider billing, and you operate the application and ledger.

### How is agentic-billing different from Stripe Billing?

agentic-billing adds previews, commands, agent tools, and selected ledger helpers over Stripe. Stripe Billing remains the underlying provider for remote billing operations.

### How is agentic-billing different from Chargebee?

agentic-billing is a toolkit over Stripe with a small local or D1 ledger. Chargebee provides its own subscription billing service and API.

### Can I preview without a Stripe key?

agentic-billing previews billing calls without a key. Pass a price ID directly, or set the environment variable for a plan name.

### Does live mode always charge real money?

agentic-billing uses the key you supply for provider calls. A Stripe test key selects test resources; `--live` means the adapter calls Stripe.

### Are webhook replays safe after a partial failure?

agentic-billing detects repeated recorded event IDs. Its ledger writes are separate operations, so partial failures need application recovery.

### Does agentic-billing automatically keep the ledger in sync?

agentic-billing applies handled events through the CLI webhook command or explicit SDK/MCP ledger operations. Creating a subscription does not automatically write its ledger state.

### Are cost reports Stripe invoice totals?

agentic-billing tracks local units for selected operations. These counters do not represent provider charges and reset with the process.

## License

MIT. Copyright Pooria Arab.
