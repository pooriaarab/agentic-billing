import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VendorError } from "./core.js";
import { describe, expect, test } from "vitest";
import { BillingError } from "./billing.js";
import {
  D1Ledger,
  LEDGER_SCHEMA_SQL,
  ledgerForEnv,
  loadFileLedger,
  MemoryLedger,
} from "./ledger.js";

describe("MemoryLedger", () => {
  test("records events once", async () => {
    const ledger = new MemoryLedger();
    await ledger.ensureSchema();
    const event = {
      eventId: "evt_1",
      type: "invoice.paid",
      customerId: "cus_1",
      livemode: false,
      receivedAt: new Date().toISOString(),
    };
    await expect(ledger.recordEvent(event)).resolves.toEqual({
      duplicate: false,
    });
    await expect(ledger.recordEvent(event)).resolves.toEqual({
      duplicate: true,
    });
  });

  test("upserts and reads subscriptions", async () => {
    const ledger = new MemoryLedger();
    await expect(ledger.getSubscription("sub_x")).resolves.toBeNull();
    await ledger.upsertSubscription({
      customerId: "cus_1",
      subscriptionId: "sub_1",
      status: "trialing",
      priceId: "price_1",
      quantity: 2,
      trialEnd: null,
      livemode: false,
    });
    const first = await ledger.getSubscription("sub_1");
    expect(first?.status).toBe("trialing");
    await ledger.upsertSubscription({
      customerId: "cus_1",
      subscriptionId: "sub_1",
      status: "active",
      priceId: "price_1",
      quantity: 2,
      trialEnd: null,
      livemode: false,
    });
    expect((await ledger.getSubscription("sub_1"))?.status).toBe("active");
  });

  test("lists recent events newest first", async () => {
    const ledger = new MemoryLedger();
    await ledger.recordEvent({
      eventId: "evt_old",
      type: "a",
      livemode: false,
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    await ledger.recordEvent({
      eventId: "evt_new",
      type: "b",
      livemode: false,
      receivedAt: "2026-02-01T00:00:00.000Z",
    });
    const events = await ledger.recentEvents();
    expect(events.map((e) => e.eventId)).toEqual(["evt_new", "evt_old"]);
    expect(await ledger.recentEvents(1)).toHaveLength(1);
  });

  test("saves and loads a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const path = join(dir, "nested", "ledger.json");
    const ledger = new MemoryLedger();
    await ledger.upsertSubscription({
      customerId: "cus_1",
      subscriptionId: "sub_1",
      status: "active",
      priceId: "",
      quantity: 1,
      trialEnd: null,
      livemode: false,
    });
    ledger.save(path);
    const loaded = loadFileLedger(path);
    expect((await loaded.getSubscription("sub_1"))?.status).toBe("active");
    const missing = loadFileLedger(join(dir, "absent.json"));
    expect(await missing.recentEvents()).toEqual([]);
  });
});

interface StubReply {
  ok: boolean;
  status?: number;
  json?: unknown;
  throws?: unknown;
}

function stubFetch(replies: StubReply[]): {
  fetchFn: typeof fetch;
  calls: { url: string; body: unknown; auth: string | null }[];
} {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const reply = replies.shift() ?? replies[replies.length - 1];
    if (reply === undefined) throw new Error("no stub reply left");
    if (reply.throws !== undefined) throw reply.throws;
    calls.push({
      url: String(url),
      body:
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      auth:
        (init?.headers as Record<string, string> | undefined)?.authorization ??
        null,
    });
    return {
      ok: reply.ok,
      status: reply.status ?? 200,
      json: async () => {
        if (reply.json === "NOT_JSON") throw new Error("bad json");
        return reply.json;
      },
    } as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

const D1 = { accountId: "acct_1", databaseId: "db_1", apiToken: "token_1" };

function okResult(result: unknown): StubReply {
  return { ok: true, json: { success: true, errors: [], result: [result] } };
}

describe("D1Ledger", () => {
  test("posts schema with auth", async () => {
    const { fetchFn, calls } = stubFetch([okResult({ meta: {} })]);
    const ledger = new D1Ledger({ ...D1, fetchFn });
    await ledger.ensureSchema();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct_1/d1/database/db_1/query",
    );
    expect(calls[0].auth).toBe("Bearer token_1");
    expect(String((calls[0].body as { sql: string }).sql)).toContain(
      "CREATE TABLE IF NOT EXISTS billing_events",
    );
    expect(LEDGER_SCHEMA_SQL).toContain("billing_subscriptions");
    expect(LEDGER_SCHEMA_SQL).toContain("billing_usage");
  });

  test("detects duplicate events", async () => {
    const { fetchFn } = stubFetch([
      okResult({ meta: { changes: 1 } }),
      okResult({ meta: { changes: 0 } }),
    ]);
    const ledger = new D1Ledger({ ...D1, fetchFn });
    await expect(
      ledger.recordEvent({
        eventId: "evt_1",
        type: "invoice.paid",
        livemode: false,
        receivedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual({ duplicate: false });
    await expect(
      ledger.recordEvent({
        eventId: "evt_1",
        type: "invoice.paid",
        livemode: false,
        receivedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual({ duplicate: true });
  });

  test("upserts and reads subscriptions", async () => {
    const { fetchFn, calls } = stubFetch([
      okResult({ meta: { changes: 1 } }),
      okResult({
        results: [
          {
            subscription_id: "sub_1",
            customer_id: "cus_1",
            status: "active",
            price_id: "price_1",
            quantity: 2,
            trial_end: null,
            livemode: 0,
            updated_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      }),
      okResult({ results: [] }),
    ]);
    const ledger = new D1Ledger({ ...D1, fetchFn });
    await ledger.upsertSubscription({
      customerId: "cus_1",
      subscriptionId: "sub_1",
      status: "active",
      priceId: "price_1",
      quantity: 2,
      trialEnd: null,
      livemode: false,
    });
    expect(String((calls[0].body as { sql: string }).sql)).toContain(
      "ON CONFLICT(subscription_id)",
    );
    await expect(ledger.getSubscription("sub_1")).resolves.toMatchObject({
      subscriptionId: "sub_1",
      customerId: "cus_1",
      status: "active",
      quantity: 2,
      trialEnd: null,
      livemode: false,
    });
    await expect(ledger.getSubscription("sub_x")).resolves.toBeNull();
  });

  test("records usage and lists events", async () => {
    const { fetchFn } = stubFetch([
      okResult({ meta: { changes: 1 } }),
      okResult({
        results: [
          {
            event_id: "evt_1",
            type: "invoice.paid",
            subscription_id: "sub_1",
            customer_id: "cus_1",
            livemode: 1,
            received_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ]);
    const ledger = new D1Ledger({ ...D1, fetchFn });
    await ledger.recordUsage({
      identifier: "use_1",
      eventName: "tokens",
      customerId: "cus_1",
      value: 25,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(ledger.recentEvents()).resolves.toEqual([
      {
        eventId: "evt_1",
        type: "invoice.paid",
        subscriptionId: "sub_1",
        customerId: "cus_1",
        livemode: true,
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("throws on transport, status, and API failures", async () => {
    const net = new D1Ledger({
      ...D1,
      fetchFn: stubFetch([{ ok: true, throws: new Error("down") }]).fetchFn,
    });
    await expect(net.ensureSchema()).rejects.toThrow(VendorError);
    const bad = new D1Ledger({
      ...D1,
      fetchFn: stubFetch([{ ok: false, status: 500, json: {} }]).fetchFn,
    });
    const error = await bad.ensureSchema().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).status).toBe(500);
    const api = new D1Ledger({
      ...D1,
      fetchFn: stubFetch([
        { ok: true, json: { success: false, errors: [{ message: "nope" }] } },
      ]).fetchFn,
    });
    await expect(api.ensureSchema()).rejects.toThrow(/nope/);
    const html = new D1Ledger({
      ...D1,
      fetchFn: stubFetch([{ ok: true, json: "NOT_JSON" }]).fetchFn,
    });
    await expect(html.ensureSchema()).rejects.toThrow(/no JSON/);
  });

  test("needs credentials", () => {
    expect(
      () => new D1Ledger({ accountId: "", databaseId: "d", apiToken: "t" }),
    ).toThrow(BillingError);
    expect(
      () => new D1Ledger({ accountId: "a", databaseId: "d", apiToken: " " }),
    ).toThrow(BillingError);
  });
});

describe("ledgerForEnv", () => {
  test("picks d1 live and memory dry", () => {
    expect(
      ledgerForEnv(
        {
          CLOUDFLARE_ACCOUNT_ID: "a",
          CLOUDFLARE_D1_DATABASE_ID: "d",
          CLOUDFLARE_API_TOKEN: "t",
        },
        true,
      ).name,
    ).toBe("d1");
    expect(ledgerForEnv({}, false).name).toBe("memory");
    expect(() => ledgerForEnv({}, true)).toThrow(BillingError);
  });

  test("loads a file ledger from a path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-env-"));
    const path = join(dir, "ledger.json");
    const first = new MemoryLedger();
    first.save(path);
    expect(ledgerForEnv({}, false, path).name).toBe("memory");
  });
});
