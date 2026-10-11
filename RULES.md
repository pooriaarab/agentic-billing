# agentic-billing rules

These rules bind every run of agentic-billing. They also bind
agents that drive this pack over MCP.

1. Preview before you act. Run each billing call with dry run first.
2. Run live only when asked. A preview is not a promise to bill.
3. Respect guards. A denied call stays denied.
4. Report failures as failures. Adapters throw, and callers surface
   the error. No silent success follows a failed call.
5. Verify webhooks. Check the signature before you apply an event.
6. Keep modes apart. Test events never reach a live ledger.
7. Count the cost. Read the cost report before you close a task.

Pack: Bill subscriptions, invoices, and metered units over Stripe. Keywords: stripe, subscriptions, invoicing, agentic-suite, claude-code, codex, cli, mcp.
