# agentic-billing agent guide

Bill subscriptions, invoices, and metered units over Stripe.

## Mental model

A billing intent goes in. A Stripe receipt comes out. One core
serves all three faces, so each face returns the same shape.

## The three faces

- SDK: `import { createBillingAdapter } from "agentic-billing"`.
- CLI: `npx agentic-billing subscribe --email ... --plan ...`.
- MCP: `npx agentic-billing mcp`, then call a tool below.

Keywords: stripe, subscriptions, invoicing, agentic-suite,
claude-code, codex, cli, mcp.

## MCP tools

| Tool | Use it for |
| --- | --- |
| billing_checkout | Build a checkout session. Dry run previews. |
| billing_subscribe | Create a subscription. Dry run previews. |
| billing_status | Read status with its access check. |
| billing_cancel | Cancel a subscription. Dry run previews. |
| billing_invoice | Draft or finalize an invoice. Dry run previews. |
| billing_usage | Report metered units. Dry run previews. |
| billing_portal | Build a portal link. Dry run previews. |
| billing_webhook_plan | Plan the writes one event needs. |
| ledger_record_event | Store one event id. Replays stay idempotent. |
| ledger_upsert_subscription | Store the latest subscription state. |
| ledger_events | List recent ledger events. |
| ledger_subscription | Read one subscription row. |
| billing_policy | Check access for a status. |
| get_cost_report | Read session cost totals. |

## The loop

1. Discover the tools with `tools/list`.
2. Preview the call with a billing tool and dryRun true.
3. Run the live call with dryRun false when asked.
4. Plan each webhook with `billing_webhook_plan`.
5. Apply the plan with the ledger tools.
6. Read `get_cost_report` and state the cost.

## Rules

- Preview with dry run before each live call.
- Run live only when the user asks for live.
- Stop when a guard denies the call. State the reason.
- Report adapter errors as errors. Never present them as success.
- Keep test events out of live ledgers.
- State the cost report before you claim the task is done.
