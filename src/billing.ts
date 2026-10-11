// Pure billing logic: price catalog, access policy, webhook plans.
//
// This module touches no network and needs no keys, so tests cover
// every branch and the edge worker reuses it as is.

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

export type BillingMode = "test" | "live";

export function modeForKey(secretKey: string): BillingMode {
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  throw new BillingError("Stripe key must start with sk_test_ or sk_live_");
}

export function catalogEnvName(catalogKey: string): string {
  const name = catalogKey.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (name.replace(/_/g, "").length === 0) {
    throw new BillingError("catalog key must hold a letter or a digit");
  }
  return `BILLING_PRICE_${name}`;
}

export function resolvePriceId(
  catalogKey: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const direct = catalogKey.trim();
  if (direct.startsWith("price_")) return direct;
  const varName = catalogEnvName(direct);
  const value = env[varName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BillingError(
      `set ${varName} to a Stripe price id, or pass price_... directly`,
    );
  }
  return value.trim();
}

export function assertEmail(value: string): string {
  const email = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  throw new BillingError(`"${value}" is not an email address`);
}

export function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BillingError(`${label} must not be empty`);
  }
  return trimmed;
}

export function assertPositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BillingError(`${label} must be an integer of 1 or more`);
  }
  return value;
}

export function assertNonNegativeInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new BillingError(`${label} must be an integer of 0 or more`);
  }
  return value;
}

export function assertCurrency(value: string): string {
  const code = value.trim().toLowerCase();
  if (/^[a-z]{3}$/.test(code)) return code;
  throw new BillingError(`"${value}" is not a 3-letter currency code`);
}

// Access policy. The ledger holds the status, this check reads it.
// trialing and active allow. past_due warns inside a grace window
// and denies past it. All other states deny.

export type AccessDecision = "allow" | "warn" | "deny";

export interface AccessCheck {
  decision: AccessDecision;
  reason: string;
  status: string;
}

export interface AccessOptions {
  pastDueGraceDays?: number;
  daysPastDue?: number;
}

export function checkAccess(
  status: string,
  options: AccessOptions = {},
): AccessCheck {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "active":
    case "trialing":
      return {
        decision: "allow",
        reason: `${normalized} is in good standing`,
        status: normalized,
      };
    case "past_due": {
      const grace = options.pastDueGraceDays ?? 0;
      const days = options.daysPastDue ?? 0;
      if (days <= grace) {
        return {
          decision: "warn",
          reason: `past_due inside a ${grace} day grace window`,
          status: normalized,
        };
      }
      return {
        decision: "deny",
        reason: "past_due past the grace window",
        status: normalized,
      };
    }
    case "canceled":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    case "paused":
      return {
        decision: "deny",
        reason: `${normalized} holds no access`,
        status: normalized,
      };
    default:
      return {
        decision: "deny",
        reason: `unknown status "${status}"`,
        status: normalized,
      };
  }
}

// Webhook plans. Given one Stripe event, name the ledger writes it
// needs and the access check it implies. The caller applies the ops
// to a ledger. Events outside the handled set need no write.

export interface WebhookObject {
  id: string;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  status?: string;
}

export interface LedgerOpRecordEvent {
  op: "recordEvent";
  eventId: string;
  type: string;
  customerId?: string;
  subscriptionId?: string;
  livemode: boolean;
}

export interface LedgerOpUpsertSubscription {
  op: "upsertSubscription";
  customerId: string;
  subscriptionId: string;
  status: string;
  livemode: boolean;
}

export type LedgerOp = LedgerOpRecordEvent | LedgerOpUpsertSubscription;

export interface WebhookPlanHandled {
  handled: true;
  ops: LedgerOp[];
  access: AccessCheck | null;
  note: string;
}

export interface WebhookPlanIgnored {
  handled: false;
  reason: string;
}

export type WebhookPlan = WebhookPlanHandled | WebhookPlanIgnored;

export const HANDLED_WEBHOOK_EVENTS: readonly string[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
];

function idOf(value: string | { id: string } | null | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return value.id;
  return undefined;
}

export interface WebhookPlanInput {
  eventId: string;
  type: string;
  object: WebhookObject;
  livemode?: boolean;
}

export function planWebhookEvent(input: WebhookPlanInput): WebhookPlan {
  const livemode = input.livemode ?? false;
  const base = { eventId: input.eventId, type: input.type, livemode };
  switch (input.type) {
    case "checkout.session.completed": {
      const customerId = idOf(input.object.customer);
      const subscriptionId = idOf(input.object.subscription);
      if (customerId === undefined) {
        return {
          handled: false,
          reason: "checkout session carries no customer",
        };
      }
      const ops: LedgerOp[] = [
        { op: "recordEvent", ...base, customerId, subscriptionId },
      ];
      if (subscriptionId !== undefined) {
        ops.push({
          op: "upsertSubscription",
          customerId,
          subscriptionId,
          status: "incomplete",
          livemode,
        });
      }
      return {
        handled: true,
        ops,
        access: null,
        note: "link the customer, then wait for subscription events",
      };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const customerId = idOf(input.object.customer);
      const status = input.object.status ?? "unknown";
      if (customerId === undefined) {
        return {
          handled: false,
          reason: "subscription event carries no customer",
        };
      }
      return {
        handled: true,
        ops: [
          {
            op: "recordEvent",
            ...base,
            customerId,
            subscriptionId: input.object.id,
          },
          {
            op: "upsertSubscription",
            customerId,
            subscriptionId: input.object.id,
            status,
            livemode,
          },
        ],
        access: checkAccess(status),
        note: `subscription ${input.type} stores status ${status}`,
      };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const customerId = idOf(input.object.customer);
      const subscriptionId = idOf(input.object.subscription);
      if (customerId === undefined) {
        return {
          handled: false,
          reason: "invoice event carries no customer",
        };
      }
      return {
        handled: true,
        ops: [
          { op: "recordEvent", ...base, customerId, subscriptionId },
        ],
        access:
          input.type === "invoice.payment_failed"
            ? checkAccess("past_due")
            : null,
        note:
          input.type === "invoice.payment_failed"
            ? "flag the account and point at billing"
            : "record a paid collection",
      };
    }
    default:
      return {
        handled: false,
        reason: `event ${input.type} needs no ledger write`,
      };
  }
}

// Webhook envelopes. Parse the raw body, check the shape, and hand
// the plan step a typed object. Verification lives in vendors.ts.

export interface WebhookEnvelope {
  id: string;
  type: string;
  object: WebhookObject;
  livemode: boolean;
}

function refOf(
  value: unknown,
): string | { id: string } | null | undefined {
  if (value === null || value === undefined) return value ?? undefined;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    return { id: (value as { id: string }).id };
  }
  return undefined;
}

export function parseWebhookEnvelope(rawBody: string): WebhookEnvelope {
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    throw new BillingError("webhook body holds no valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    throw new BillingError("webhook body holds no event");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new BillingError("webhook event carries no id");
  }
  if (typeof record.type !== "string" || record.type.length === 0) {
    throw new BillingError("webhook event carries no type");
  }
  const data = record.data;
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { object?: unknown }).object !== "object" ||
    (data as { object?: unknown }).object === null
  ) {
    throw new BillingError("webhook event carries no object");
  }
  const object = (data as { object: Record<string, unknown> }).object;
  if (typeof object.id !== "string" || object.id.length === 0) {
    throw new BillingError("webhook object carries no id");
  }
  return {
    id: record.id,
    type: record.type,
    object: {
      id: object.id,
      customer: refOf(object.customer),
      subscription: refOf(object.subscription),
      status: typeof object.status === "string" ? object.status : undefined,
    },
    livemode: record.livemode === true,
  };
}

// Deterministic dry run ids. Same seed, same id, so previews stay
// stable across runs without touching the network.

export function dryId(prefix: string, seed: string): string {
  const rounds = [`${prefix}:${seed}`, `${seed}:${prefix}`];
  let out = "";
  for (const round of rounds) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < round.length; i += 1) {
      hash ^= round.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return `${prefix}_${out}`;
}
