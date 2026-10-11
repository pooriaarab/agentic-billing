import { describe, expect, test } from "vitest";
import {
  BillingError,
  catalogEnvName,
  checkAccess,
  dryId,
  HANDLED_WEBHOOK_EVENTS,
  modeForKey,
  parseWebhookEnvelope,
  planWebhookEvent,
  resolvePriceId,
  assertEmail,
} from "./billing.js";

describe("modeForKey", () => {
  test("maps test and live keys", () => {
    expect(modeForKey("sk_test_abc")).toBe("test");
    expect(modeForKey("sk_live_abc")).toBe("live");
  });

  test("rejects other keys", () => {
    expect(() => modeForKey("pk_test_abc")).toThrow(BillingError);
  });
});

describe("catalogEnvName", () => {
  test("maps keys to env names", () => {
    expect(catalogEnvName("starter-monthly")).toBe(
      "BILLING_PRICE_STARTER_MONTHLY",
    );
    expect(catalogEnvName("  growth yearly ")).toBe(
      "BILLING_PRICE_GROWTH_YEARLY",
    );
  });

  test("rejects empty keys", () => {
    expect(() => catalogEnvName("---")).toThrow(BillingError);
  });
});

describe("resolvePriceId", () => {
  test("passes price ids through", () => {
    expect(resolvePriceId("price_123", {})).toBe("price_123");
  });

  test("resolves catalog keys from env", () => {
    expect(
      resolvePriceId("starter-monthly", {
        BILLING_PRICE_STARTER_MONTHLY: "price_123",
      }),
    ).toBe("price_123");
  });

  test("names the missing variable", () => {
    expect(() => resolvePriceId("starter-monthly", {})).toThrow(
      /BILLING_PRICE_STARTER_MONTHLY/,
    );
  });
});

describe("assertEmail", () => {
  test("accepts plain emails", () => {
    expect(assertEmail("buyer@example.com")).toBe("buyer@example.com");
  });

  test("rejects non emails", () => {
    expect(() => assertEmail("not-an-email")).toThrow(BillingError);
    expect(() => assertEmail("a@b")).toThrow(BillingError);
  });
});

describe("checkAccess", () => {
  test("allows active and trialing", () => {
    expect(checkAccess("active").decision).toBe("allow");
    expect(checkAccess("trialing").decision).toBe("allow");
  });

  test("warns past due inside grace, denies past it", () => {
    expect(checkAccess("past_due").decision).toBe("warn");
    expect(
      checkAccess("past_due", { pastDueGraceDays: 3, daysPastDue: 2 }).decision,
    ).toBe("warn");
    expect(
      checkAccess("past_due", { pastDueGraceDays: 3, daysPastDue: 4 }).decision,
    ).toBe("deny");
  });

  test("denies terminal and unknown states", () => {
    for (const status of [
      "canceled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
      "bogus",
    ]) {
      expect(checkAccess(status).decision).toBe("deny");
    }
  });

  test("normalizes case and space", () => {
    expect(checkAccess("  Active ").decision).toBe("allow");
  });
});

describe("planWebhookEvent", () => {
  test("lists the handled set", () => {
    expect(HANDLED_WEBHOOK_EVENTS).toContain("checkout.session.completed");
    expect(HANDLED_WEBHOOK_EVENTS).toContain("invoice.payment_failed");
    expect(HANDLED_WEBHOOK_EVENTS).toHaveLength(8);
  });

  test("plans checkout completion with a subscription", () => {
    const plan = planWebhookEvent({
      eventId: "evt_1",
      type: "checkout.session.completed",
      object: { id: "cs_1", customer: "cus_1", subscription: "sub_1" },
      livemode: false,
    });
    expect(plan.handled).toBe(true);
    if (!plan.handled) return;
    expect(plan.ops).toHaveLength(2);
    expect(plan.ops[0]).toMatchObject({ op: "recordEvent", eventId: "evt_1" });
    expect(plan.ops[1]).toMatchObject({
      op: "upsertSubscription",
      subscriptionId: "sub_1",
      status: "incomplete",
    });
    expect(plan.access).toBeNull();
  });

  test("rejects checkout without a customer", () => {
    const plan = planWebhookEvent({
      eventId: "evt_1",
      type: "checkout.session.completed",
      object: { id: "cs_1" },
    });
    expect(plan).toEqual({
      handled: false,
      reason: "checkout session carries no customer",
    });
  });

  test("plans subscription updates with access", () => {
    const plan = planWebhookEvent({
      eventId: "evt_2",
      type: "customer.subscription.updated",
      object: { id: "sub_1", customer: "cus_1", status: "active" },
      livemode: true,
    });
    expect(plan.handled).toBe(true);
    if (!plan.handled) return;
    expect(plan.access?.decision).toBe("allow");
    expect(plan.ops[1]).toMatchObject({ op: "upsertSubscription", livemode: true });
  });

  test("plans deletion as deny", () => {
    const plan = planWebhookEvent({
      eventId: "evt_3",
      type: "customer.subscription.deleted",
      object: { id: "sub_1", customer: "cus_1", status: "canceled" },
    });
    expect(plan.handled).toBe(true);
    if (!plan.handled) return;
    expect(plan.access?.decision).toBe("deny");
  });

  test("plans paid invoices with no access change", () => {
    const plan = planWebhookEvent({
      eventId: "evt_4",
      type: "invoice.paid",
      object: { id: "in_1", customer: "cus_1", subscription: "sub_1" },
    });
    expect(plan.handled).toBe(true);
    if (!plan.handled) return;
    expect(plan.ops).toHaveLength(1);
    expect(plan.access).toBeNull();
  });

  test("plans failed invoices as past due", () => {
    const plan = planWebhookEvent({
      eventId: "evt_5",
      type: "invoice.payment_failed",
      object: { id: "in_1", customer: "cus_1" },
    });
    expect(plan.handled).toBe(true);
    if (!plan.handled) return;
    expect(plan.access?.decision).toBe("warn");
  });

  test("ignores unhandled events", () => {
    const plan = planWebhookEvent({
      eventId: "evt_6",
      type: "charge.refunded",
      object: { id: "ch_1" },
    });
    expect(plan.handled).toBe(false);
  });
});

describe("parseWebhookEnvelope", () => {
  const raw = JSON.stringify({
    id: "evt_1",
    type: "customer.subscription.updated",
    livemode: false,
    data: {
      object: { id: "sub_1", customer: "cus_1", status: "active" },
    },
  });

  test("parses a full event", () => {
    expect(parseWebhookEnvelope(raw)).toEqual({
      id: "evt_1",
      type: "customer.subscription.updated",
      object: { id: "sub_1", customer: "cus_1", subscription: undefined, status: "active" },
      livemode: false,
    });
  });

  test("rejects broken bodies", () => {
    expect(() => parseWebhookEnvelope("nope")).toThrow(BillingError);
    expect(() => parseWebhookEnvelope(JSON.stringify({}))).toThrow(BillingError);
    expect(() =>
      parseWebhookEnvelope(JSON.stringify({ id: "e", type: "t" })),
    ).toThrow(/object/);
    expect(() =>
      parseWebhookEnvelope(
        JSON.stringify({ id: "e", type: "t", data: { object: {} } }),
      ),
    ).toThrow(/id/);
  });
});

describe("dryId", () => {
  test("stays stable and distinct", () => {
    expect(dryId("sub", "a")).toBe(dryId("sub", "a"));
    expect(dryId("sub", "a")).not.toBe(dryId("sub", "b"));
    expect(dryId("sub", "a")).toMatch(/^sub_[0-9a-f]{16}$/);
  });
});
