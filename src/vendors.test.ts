import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { getCostReport, resetCosts, VendorError } from "./core.js";
import { describe, expect, test } from "vitest";
import { BillingError } from "./billing.js";
import { MemoryLedger } from "./ledger.js";
import {
  assertValidWebhookSignature,
  billingAdapterForEnv,
  createBillingAdapter,
  DryRunBillingAdapter,
  reportPackUsage,
  StripeBillingAdapter,
  verifyWebhookEnvelope,
} from "./vendors.js";

function signedHeader(raw: string, secret: string, timestamp: number): string {
  const sig = createHmac("sha256", secret)
    .update(`${timestamp}.${raw}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

describe("DryRunBillingAdapter", () => {
  const adapter = new DryRunBillingAdapter();

  test("previews checkout with no url", async () => {
    const first = await adapter.checkout({
      priceId: "price_123",
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/no",
    });
    const second = await adapter.checkout({
      priceId: "price_123",
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/no",
    });
    expect(first).toMatchObject({ dryRun: true, url: null, mode: "subscription" });
    expect(first.sessionId).toBe(second.sessionId);
  });

  test("previews subscribe as trialing or active", async () => {
    const trial = await adapter.subscribe({
      customerEmail: "buyer@example.com",
      priceId: "price_123",
      trialDays: 7,
    });
    expect(trial.status).toBe("trialing");
    expect(trial.trialEnd).not.toBeNull();
    const plain = await adapter.subscribe({
      customerId: "cus_1",
      priceId: "price_123",
    });
    expect(plain).toMatchObject({
      dryRun: true,
      customerId: "cus_1",
      status: "active",
      trialEnd: null,
    });
  });

  test("rejects subscribe without a customer", async () => {
    await expect(
      adapter.subscribe({ priceId: "price_123" }),
    ).rejects.toThrow(BillingError);
  });

  test("previews status as deny", async () => {
    const result = await adapter.status("sub_1");
    expect(result).toMatchObject({
      dryRun: true,
      subscriptionId: "sub_1",
      status: "preview",
    });
    expect(result.access.decision).toBe("deny");
  });

  test("previews cancel, usage, and portal", async () => {
    const cancel = await adapter.cancel({ subscriptionId: "sub_1" });
    expect(cancel).toMatchObject({ dryRun: true, status: "canceled" });
    const usage = await adapter.usage({
      eventName: "tokens",
      customerId: "cus_1",
      value: 25,
    });
    expect(usage).toMatchObject({ dryRun: true, eventName: "tokens", value: 25 });
    const again = await adapter.usage({
      eventName: "tokens",
      customerId: "cus_1",
      value: 25,
    });
    expect(again.identifier).toBe(usage.identifier);
    const portal = await adapter.portal({ customerId: "cus_1" });
    expect(portal).toEqual({ dryRun: true, url: null });
  });

  test("previews invoices by price or amount", async () => {
    const byPrice = await adapter.invoice({
      customerId: "cus_1",
      priceId: "price_123",
    });
    expect(byPrice).toMatchObject({ dryRun: true, status: "draft", amountDue: 0 });
    const byAmount = await adapter.invoice({
      customerId: "cus_1",
      amountCents: 500,
      currency: "USD",
    });
    expect(byAmount).toMatchObject({ amountDue: 500, currency: "usd" });
    await expect(
      adapter.invoice({ customerId: "cus_1" }),
    ).rejects.toThrow(BillingError);
    await expect(
      adapter.invoice({ customerId: "cus_1", priceId: "price_1", amountCents: 5 }),
    ).rejects.toThrow(/not both/);
  });

  test("validates inputs", async () => {
    await expect(
      adapter.checkout({
        priceId: "price_1",
        successUrl: "notaurl",
        cancelUrl: "https://example.com/no",
      }),
    ).rejects.toThrow(BillingError);
    await expect(
      adapter.usage({ eventName: "t", customerId: "c", value: Number.NaN }),
    ).rejects.toThrow(BillingError);
  });
});

describe("createBillingAdapter", () => {
  test("defaults to dry run", () => {
    expect(createBillingAdapter().name).toBe("dry-run");
    expect(createBillingAdapter({ live: false }).name).toBe("dry-run");
  });

  test("needs a key for live", () => {
    expect(() => createBillingAdapter({ live: true })).toThrow(BillingError);
    expect(
      createBillingAdapter({ live: true, secretKey: "sk_test_x" }).name,
    ).toBe("stripe");
  });

  test("reads the key from env", () => {
    expect(
      billingAdapterForEnv({ STRIPE_SECRET_KEY: "sk_test_x" }, true).name,
    ).toBe("stripe");
    expect(billingAdapterForEnv({}, false).name).toBe("dry-run");
  });
});

function stubClient(impl: Record<string, unknown>): Stripe {
  return {
    checkout: { sessions: { create: impl.checkout } },
    customers: { create: impl.customer },
    subscriptions: {
      create: impl.subCreate,
      retrieve: impl.subGet,
      cancel: impl.subCancel,
    },
    invoiceItems: { create: impl.item },
    invoices: { create: impl.invCreate, finalizeInvoice: impl.invFinal },
    billing: { meterEvents: { create: impl.meter } },
    billingPortal: { sessions: { create: impl.portal } },
  } as unknown as Stripe;
}

describe("StripeBillingAdapter", () => {
  test("maps checkout and portal results", async () => {
    const adapter = new StripeBillingAdapter(
      "sk_test_x",
      {
        client: stubClient({
          checkout: async () => ({ id: "cs_1", url: "https://pay/u", mode: "subscription" }),
          portal: async () => ({ url: "https://portal/u" }),
        }),
      },
    );
    await expect(
      adapter.checkout({
        priceId: "price_1",
        successUrl: "https://example.com/ok",
        cancelUrl: "https://example.com/no",
      }),
    ).resolves.toEqual({
      dryRun: false,
      sessionId: "cs_1",
      url: "https://pay/u",
      mode: "subscription",
    });
    await expect(adapter.portal({ customerId: "cus_1" })).resolves.toEqual({
      dryRun: false,
      url: "https://portal/u",
    });
  });

  test("creates a customer when subscribe has an email only", async () => {
    const calls: string[] = [];
    const adapter = new StripeBillingAdapter(
      "sk_test_x",
      {
        client: stubClient({
          customer: async () => {
            calls.push("customer");
            return { id: "cus_9" };
          },
          subCreate: async () => ({
            id: "sub_9",
            customer: "cus_9",
            status: "trialing",
            trial_end: 1_800_000_000,
          }),
        }),
      },
    );
    const result = await adapter.subscribe({
      customerEmail: "buyer@example.com",
      priceId: "price_1",
      quantity: 2,
    });
    expect(calls).toEqual(["customer"]);
    expect(result).toMatchObject({
      dryRun: false,
      customerId: "cus_9",
      subscriptionId: "sub_9",
      status: "trialing",
      quantity: 2,
    });
    expect(result.trialEnd).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  test("maps status, cancel, invoice, and usage", async () => {
    const adapter = new StripeBillingAdapter(
      "sk_test_x",
      {
        client: stubClient({
          subGet: async () => ({
            id: "sub_1",
            customer: { id: "cus_1" },
            status: "past_due",
          }),
          subCancel: async () => ({
            id: "sub_1",
            status: "canceled",
            canceled_at: 1_800_000_100,
          }),
          item: async () => ({ id: "ii_1" }),
          invCreate: async () => ({ id: "in_1" }),
          invFinal: async () => ({
            id: "in_1",
            status: "open",
            amount_due: 500,
            currency: "usd",
            hosted_invoice_url: "https://inv/u",
          }),
          meter: async () => ({ identifier: "use_1", event_name: "tokens" }),
        }),
      },
    );
    const status = await adapter.status("sub_1");
    expect(status).toMatchObject({
      dryRun: false,
      customerId: "cus_1",
      status: "past_due",
    });
    expect(status.access.decision).toBe("warn");
    const cancel = await adapter.cancel({ subscriptionId: "sub_1" });
    expect(cancel).toMatchObject({ status: "canceled" });
    expect(cancel.canceledAt).toBe(new Date(1_800_000_100 * 1000).toISOString());
    const invoice = await adapter.invoice({
      customerId: "cus_1",
      amountCents: 500,
    });
    expect(invoice).toMatchObject({
      dryRun: false,
      invoiceId: "in_1",
      status: "open",
      amountDue: 500,
      currency: "usd",
      hostedUrl: "https://inv/u",
    });
    const usage = await adapter.usage({
      eventName: "tokens",
      customerId: "cus_1",
      value: 25,
    });
    expect(usage).toEqual({
      dryRun: false,
      identifier: "use_1",
      eventName: "tokens",
      value: 25,
    });
  });

  test("wraps vendor failures with status", async () => {
    const adapter = new StripeBillingAdapter(
      "sk_test_x",
      {
        client: stubClient({
          subGet: async () => {
            throw Object.assign(new Error("card declined"), { statusCode: 402 });
          },
        }),
      },
    );
    const error = await adapter.status("sub_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VendorError);
    expect((error as VendorError).status).toBe(402);
    expect((error as Error).message).toMatch(/stripe status failed/);
  });

  test("passes config errors through unwrapped", async () => {
    const adapter = new StripeBillingAdapter("sk_test_x", {
      client: stubClient({}),
    });
    await expect(adapter.subscribe({ priceId: "price_1" })).rejects.toThrow(
      BillingError,
    );
  });
});

describe("webhook signatures", () => {
  const raw = JSON.stringify({ id: "evt_1" });
  const secret = "whsec_test";

  test("accepts a fresh signature", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(() =>
      assertValidWebhookSignature(raw, signedHeader(raw, secret, now), secret, {
        nowSec: now,
      }),
    ).not.toThrow();
  });

  test("matches the official SDK check", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = signedHeader(raw, secret, now);
    const stripe = new Stripe("sk_test_verify_only");
    expect(() =>
      stripe.webhooks.constructEvent(raw, header, secret, 300, undefined, now),
    ).not.toThrow();
    expect(() =>
      stripe.webhooks.constructEvent(raw, "t=1,v1=dead", secret),
    ).toThrow();
  });

  test("rejects stale, broken, and missing signatures", () => {
    const now = 1_800_000_000;
    expect(() =>
      assertValidWebhookSignature(
        raw,
        signedHeader(raw, secret, now - 1000),
        secret,
        { nowSec: now },
      ),
    ).toThrow(/tolerance/);
    expect(() =>
      assertValidWebhookSignature(raw, "t=1", secret, { nowSec: now }),
    ).toThrow(/no t or v1/);
    expect(() =>
      assertValidWebhookSignature(raw, signedHeader(raw, "other", now), secret, {
        nowSec: now,
      }),
    ).toThrow(/does not match/);
    expect(() => assertValidWebhookSignature(raw, null, secret)).toThrow(
      BillingError,
    );
  });

  test("verifyWebhookEnvelope parses after verify", () => {
    const body = JSON.stringify({
      id: "evt_1",
      type: "invoice.paid",
      livemode: false,
      data: { object: { id: "in_1", customer: "cus_1" } },
    });
    const now = Math.floor(Date.now() / 1000);
    const envelope = verifyWebhookEnvelope(
      body,
      signedHeader(body, secret, now),
      secret,
      { nowSec: now },
    );
    expect(envelope).toMatchObject({ id: "evt_1", type: "invoice.paid" });
  });
});

describe("reportPackUsage", () => {
  test("reportPackUsage previews Stripe and still stores local rows", async () => {
    resetCosts();
    const ledger = new MemoryLedger();
    const result = await reportPackUsage(new DryRunBillingAdapter(), ledger, {
      pack: "agentic-text",
      kind: "sms",
      customerId: "cus_1",
      units: 3,
    });
    expect(result).toMatchObject({
      dryRun: true,
      pack: "agentic-text",
      kind: "sms",
      eventName: "outreach_units",
      value: 3,
    });
    expect(ledger.snapshot().usage).toHaveLength(1);
    expect(ledger.snapshot().usage[0]).toMatchObject({
      identifier: result.identifier,
      customerId: "cus_1",
      value: 3,
    });
    expect(getCostReport().entries).toHaveLength(1);
    expect(getCostReport().entries[0]).toMatchObject({
      kind: "usage:agentic-text:sms",
      adapter: "dry-run",
      units: 3,
    });
    const again = await reportPackUsage(new DryRunBillingAdapter(), ledger, {
      pack: "agentic-text",
      kind: "sms",
      customerId: "cus_1",
      units: 3,
    });
    expect(again.identifier).toBe(result.identifier);
    expect(ledger.snapshot().usage).toHaveLength(1);
  });

  test("reportPackUsage honors custom event names and validates input", async () => {
    const ledger = new MemoryLedger();
    const adapter = new DryRunBillingAdapter();
    const custom = await reportPackUsage(adapter, ledger, {
      pack: "agentic-phone",
      kind: "call",
      customerId: "cus_2",
      units: 1,
      eventName: "answered_calls",
    });
    expect(custom.eventName).toBe("answered_calls");
    await expect(
      reportPackUsage(adapter, ledger, {
        pack: "  ",
        kind: "sms",
        customerId: "cus_1",
        units: 1,
      }),
    ).rejects.toThrow(BillingError);
    await expect(
      reportPackUsage(adapter, ledger, {
        pack: "agentic-text",
        kind: "sms",
        customerId: "cus_1",
        units: Number.NaN,
      }),
    ).rejects.toThrow(/finite number/);
  });

});
