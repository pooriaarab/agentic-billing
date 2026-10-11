import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { BillingError } from "./billing.js";
import { MemoryLedger } from "./ledger.js";
import { createMcpServer, type McpDeps } from "./mcp.js";
import { DryRunBillingAdapter } from "./vendors.js";

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] })
    .content;
  return content[0].text;
}

async function linked(deps: McpDeps = {}): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    makeAdapter: () => new DryRunBillingAdapter(),
    makeLedger: () => new MemoryLedger(),
    env: { BILLING_PRICE_STARTER_MONTHLY: "price_test_123" },
    ...deps,
  });
  await server.connect(serverTransport);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("mcp server", () => {
  test("serves fourteen tools over a client link", async () => {
    const { client, close } = await linked();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "billing_cancel",
        "billing_checkout",
        "billing_invoice",
        "billing_policy",
        "billing_portal",
        "billing_status",
        "billing_subscribe",
        "billing_usage",
        "billing_webhook_plan",
        "get_cost_report",
        "ledger_events",
        "ledger_record_event",
        "ledger_subscription",
        "ledger_upsert_subscription",
      ]);
    } finally {
      await close();
    }
  });

  test("subscribes dry by default", async () => {
    const { client, close } = await linked();
    try {
      const result = await client.callTool({
        name: "billing_subscribe",
        arguments: {
          customerEmail: "buyer@example.com",
          plan: "starter-monthly",
        },
      });
      expect(JSON.parse(textOf(result))).toMatchObject({
        dryRun: true,
        priceId: "price_test_123",
        status: "active",
      });
    } finally {
      await close();
    }
  });

  test("reports live billing errors as tool errors", async () => {
    const { client, close } = await linked({
      makeAdapter: (live: boolean) => {
        if (live) throw new BillingError("live billing needs STRIPE_SECRET_KEY");
        return new DryRunBillingAdapter();
      },
    });
    try {
      const result = await client.callTool({
        name: "billing_status",
        arguments: { subscriptionId: "sub_1", dryRun: false },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("STRIPE_SECRET_KEY");
    } finally {
      await close();
    }
  });

  test("runs status, policy, plan, and costs", async () => {
    const { client, close } = await linked();
    try {
      const status = await client.callTool({
        name: "billing_status",
        arguments: { subscriptionId: "sub_1" },
      });
      expect(JSON.parse(textOf(status)).status).toBe("preview");
      const policy = await client.callTool({
        name: "billing_policy",
        arguments: { status: "active" },
      });
      expect(JSON.parse(textOf(policy)).decision).toBe("allow");
      const plan = await client.callTool({
        name: "billing_webhook_plan",
        arguments: {
          eventId: "evt_1",
          type: "invoice.payment_failed",
          object: { id: "in_1", customer: "cus_1" },
        },
      });
      expect(JSON.parse(textOf(plan)).handled).toBe(true);
      const costs = await client.callTool({
        name: "get_cost_report",
        arguments: {},
      });
      expect(JSON.parse(textOf(costs))).toHaveProperty("entries");
    } finally {
      await close();
    }
  });

  test("writes and reads the ledger to a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-ledger-"));
    const path = join(dir, "ledger.json");
    const shared = new MemoryLedger();
    const { client, close } = await linked({
      ledgerPath: path,
      makeLedger: () => shared,
    });
    try {
      const recorded = await client.callTool({
        name: "ledger_record_event",
        arguments: { eventId: "evt_1", type: "invoice.paid" },
      });
      expect(JSON.parse(textOf(recorded))).toEqual({ duplicate: false });
      await client.callTool({
        name: "ledger_upsert_subscription",
        arguments: {
          customerId: "cus_1",
          subscriptionId: "sub_1",
          status: "active",
        },
      });
      const row = await client.callTool({
        name: "ledger_subscription",
        arguments: { subscriptionId: "sub_1" },
      });
      expect(JSON.parse(textOf(row)).status).toBe("active");
      const events = await client.callTool({
        name: "ledger_events",
        arguments: {},
      });
      expect(JSON.parse(textOf(events))).toHaveLength(1);
      const fresh = new MemoryLedger();
      fresh.load(path);
      expect((await fresh.getSubscription("sub_1"))?.status).toBe("active");
    } finally {
      await close();
    }
  });
});
