import { describe, expect, test } from "vitest";
import worker, { type WorkerEnv } from "./worker.js";

const ENV: WorkerEnv = {
  PACK_NAME: "agentic-billing",
  BILLING_PRICE_STARTER_MONTHLY: "price_test_123",
};

async function post(path: string, body: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`https://pack.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ENV,
  );
}

describe("worker", () => {
  test("serves health", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/health"),
      ENV,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pack: "agentic-billing" });
  });

  test("previews a checkout intent", async () => {
    const response = await post("/preview", {
      plan: "starter-monthly",
      quantity: 2,
      email: "buyer@example.com",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      dryRun: true,
      priceId: "price_test_123",
      quantity: 2,
      email: "buyer@example.com",
    });
  });

  test("rejects bad preview intents", async () => {
    const missing = await post("/preview", {});
    expect(missing.status).toBe(400);
    const qty = await post("/preview", { plan: "starter-monthly", quantity: 0 });
    expect(qty.status).toBe(400);
    const unknown = await post("/preview", { plan: "nope" });
    expect(unknown.status).toBe(400);
    const broken = await worker.fetch(
      new Request("https://pack.test/preview", {
        method: "POST",
        body: "nope",
      }),
      ENV,
    );
    expect(broken.status).toBe(400);
  });

  test("checks access", async () => {
    const allow = await post("/access", { status: "active" });
    expect(await allow.json()).toMatchObject({ decision: "allow" });
    const deny = await post("/access", { status: "canceled" });
    expect(await deny.json()).toMatchObject({ decision: "deny" });
    const bad = await post("/access", {});
    expect(bad.status).toBe(400);
    const nums = await post("/access", { status: "past_due", daysPastDue: -1 });
    expect(nums.status).toBe(400);
  });

  test("plans webhook events", async () => {
    const handled = await post("/webhook-plan", {
      eventId: "evt_1",
      type: "invoice.paid",
      object: { id: "in_1", customer: "cus_1" },
    });
    expect(handled.status).toBe(200);
    expect(await handled.json()).toMatchObject({ handled: true });
    const ignored = await post("/webhook-plan", {
      eventId: "evt_2",
      type: "charge.refunded",
      object: { id: "ch_1" },
    });
    expect(await ignored.json()).toMatchObject({ handled: false });
    const bad = await post("/webhook-plan", { type: "invoice.paid" });
    expect(bad.status).toBe(400);
  });

  test("answers 404 elsewhere", async () => {
    const response = await worker.fetch(
      new Request("https://pack.test/elsewhere"),
      ENV,
    );
    expect(response.status).toBe(404);
  });
});
