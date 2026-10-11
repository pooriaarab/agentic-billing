// Vendor adapters for Stripe. The live adapter calls the real API
// through the official SDK. The dry run adapter previews each call
// with stable ids and spends nothing. Both share one interface, and
// both surface failures as errors, never as quiet success.

import { createHmac, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { recordCost, VendorError } from "./core.js";
import type { Ledger } from "./ledger.js";
import {
  assertCurrency,
  assertEmail,
  assertNonEmpty,
  assertNonNegativeInt,
  assertPositiveInt,
  BillingError,
  checkAccess,
  dryId,
  parseWebhookEnvelope,
  type AccessCheck,
  type WebhookEnvelope,
} from "./billing.js";

export interface CheckoutInput {
  priceId: string;
  quantity?: number;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
}

export interface CheckoutResult {
  dryRun: boolean;
  sessionId: string;
  url: string | null;
  mode: string;
}

export interface SubscribeInput {
  customerId?: string;
  customerEmail?: string;
  priceId: string;
  quantity?: number;
  trialDays?: number;
}

export interface SubscriptionResult {
  dryRun: boolean;
  customerId: string;
  subscriptionId: string;
  status: string;
  priceId: string;
  quantity: number;
  trialEnd: string | null;
}

export interface StatusResult {
  dryRun: boolean;
  customerId: string;
  subscriptionId: string;
  status: string;
  access: AccessCheck;
}

export interface CancelInput {
  subscriptionId: string;
}

export interface CancelResult {
  dryRun: boolean;
  subscriptionId: string;
  status: string;
  canceledAt: string;
}

export interface InvoiceInput {
  customerId: string;
  priceId?: string;
  quantity?: number;
  amountCents?: number;
  currency?: string;
  description?: string;
  draft?: boolean;
}

export interface InvoiceResult {
  dryRun: boolean;
  invoiceId: string;
  status: string;
  amountDue: number;
  currency: string;
  hostedUrl: string | null;
}

export interface UsageInput {
  eventName: string;
  customerId: string;
  value: number;
  identifier?: string;
  timestamp?: number;
}

export interface UsageResult {
  dryRun: boolean;
  identifier: string;
  eventName: string;
  value: number;
}

export interface PortalInput {
  customerId: string;
  returnUrl?: string;
}

export interface PortalResult {
  dryRun: boolean;
  url: string | null;
}

export interface BillingAdapter {
  readonly name: string;
  checkout(input: CheckoutInput): Promise<CheckoutResult>;
  subscribe(input: SubscribeInput): Promise<SubscriptionResult>;
  status(subscriptionId: string): Promise<StatusResult>;
  cancel(input: CancelInput): Promise<CancelResult>;
  invoice(input: InvoiceInput): Promise<InvoiceResult>;
  usage(input: UsageInput): Promise<UsageResult>;
  portal(input: PortalInput): Promise<PortalResult>;
}

function toVendorError(action: string, error: unknown): VendorError {
  if (error instanceof VendorError) return error;
  const status =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return new VendorError(`stripe ${action} failed: ${message}`, {
    status,
    cause: error,
  });
}

function customerIdOf(value: string | { id: string }): string {
  return typeof value === "string" ? value : value.id;
}

function isoOrNull(unix: number | null | undefined): string | null {
  if (typeof unix !== "number" || !Number.isFinite(unix)) return null;
  return new Date(unix * 1000).toISOString();
}

function assertUrl(value: string, label: string): string {
  const trimmed = assertNonEmpty(value, label);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BillingError(`${label} must be a URL, got "${value}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new BillingError(`${label} must use http or https`);
  }
  return trimmed;
}

export class StripeBillingAdapter implements BillingAdapter {
  readonly name = "stripe";
  private readonly client: Stripe;

  constructor(secretKey: string, options: { client?: Stripe } = {}) {
    const key = assertNonEmpty(secretKey, "Stripe secret key");
    this.client = options.client ?? new Stripe(key);
  }

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    const price = assertNonEmpty(input.priceId, "price id");
    const quantity = assertPositiveInt(input.quantity ?? 1, "quantity");
    const successUrl = assertUrl(input.successUrl, "success url");
    const cancelUrl = assertUrl(input.cancelUrl, "cancel url");
    const trialDays =
      input.trialDays === undefined
        ? undefined
        : assertNonNegativeInt(input.trialDays, "trial days");
    const email =
      input.customerEmail === undefined
        ? undefined
        : assertEmail(input.customerEmail);
    try {
      const session = await this.client.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        ...(email === undefined ? {} : { customer_email: email }),
        ...(trialDays === undefined
          ? {}
          : { subscription_data: { trial_period_days: trialDays } }),
      });
      return {
        dryRun: false,
        sessionId: session.id,
        url: session.url,
        mode: session.mode,
      };
    } catch (error) {
      throw toVendorError("checkout", error);
    }
  }

  async subscribe(input: SubscribeInput): Promise<SubscriptionResult> {
    const priceId = assertNonEmpty(input.priceId, "price id");
    const quantity = assertPositiveInt(input.quantity ?? 1, "quantity");
    const trialDays =
      input.trialDays === undefined
        ? undefined
        : assertNonNegativeInt(input.trialDays, "trial days");
    try {
      let customerId = input.customerId?.trim() || undefined;
      if (customerId === undefined) {
        if (input.customerEmail === undefined) {
          throw new BillingError("subscribe needs a customer id or an email");
        }
        const customer = await this.client.customers.create({
          email: assertEmail(input.customerEmail),
        });
        customerId = customer.id;
      }
      const subscription = await this.client.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId, quantity }],
        ...(trialDays === undefined
          ? {}
          : { trial_period_days: trialDays }),
      });
      return {
        dryRun: false,
        customerId: customerIdOf(subscription.customer),
        subscriptionId: subscription.id,
        status: subscription.status,
        priceId,
        quantity,
        trialEnd: isoOrNull(subscription.trial_end),
      };
    } catch (error) {
      if (error instanceof BillingError) throw error;
      throw toVendorError("subscribe", error);
    }
  }

  async status(subscriptionId: string): Promise<StatusResult> {
    const id = assertNonEmpty(subscriptionId, "subscription id");
    try {
      const subscription = await this.client.subscriptions.retrieve(id);
      const status = subscription.status;
      return {
        dryRun: false,
        customerId: customerIdOf(subscription.customer),
        subscriptionId: subscription.id,
        status,
        access: checkAccess(status),
      };
    } catch (error) {
      throw toVendorError("status", error);
    }
  }

  async cancel(input: CancelInput): Promise<CancelResult> {
    const id = assertNonEmpty(input.subscriptionId, "subscription id");
    try {
      const subscription = await this.client.subscriptions.cancel(id);
      return {
        dryRun: false,
        subscriptionId: subscription.id,
        status: subscription.status,
        canceledAt:
          isoOrNull(subscription.canceled_at) ?? new Date().toISOString(),
      };
    } catch (error) {
      throw toVendorError("cancel", error);
    }
  }

  async invoice(input: InvoiceInput): Promise<InvoiceResult> {
    const customer = assertNonEmpty(input.customerId, "customer id");
    const quantity = assertPositiveInt(input.quantity ?? 1, "quantity");
    try {
      if (
        input.priceId !== undefined &&
        input.amountCents !== undefined
      ) {
        throw new BillingError("invoice takes a price or an amount, not both");
      }
      if (input.priceId !== undefined) {
        await this.client.invoiceItems.create({
          customer,
          pricing: { price: assertNonEmpty(input.priceId, "price id") },
          quantity,
        });
      } else if (input.amountCents !== undefined) {
        await this.client.invoiceItems.create({
          customer,
          amount: assertNonNegativeInt(input.amountCents, "amount"),
          currency: assertCurrency(input.currency ?? "usd"),
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
        });
      } else {
        throw new BillingError("invoice needs a price or an amount in cents");
      }
      let invoice = await this.client.invoices.create({
        customer,
        collection_method: "charge_automatically",
      });
      if (input.draft !== true) {
        invoice = await this.client.invoices.finalizeInvoice(invoice.id);
      }
      return {
        dryRun: false,
        invoiceId: invoice.id,
        status: invoice.status ?? "unknown",
        amountDue: invoice.amount_due,
        currency: invoice.currency,
        hostedUrl: invoice.hosted_invoice_url ?? null,
      };
    } catch (error) {
      if (error instanceof BillingError) throw error;
      throw toVendorError("invoice", error);
    }
  }

  async usage(input: UsageInput): Promise<UsageResult> {
    const eventName = assertNonEmpty(input.eventName, "meter event name");
    const customerId = assertNonEmpty(input.customerId, "customer id");
    if (!Number.isFinite(input.value)) {
      throw new BillingError("usage value must be a finite number");
    }
    try {
      const event = await this.client.billing.meterEvents.create({
        event_name: eventName,
        payload: {
          stripe_customer_id: customerId,
          value: String(input.value),
        },
        ...(input.identifier === undefined
          ? {}
          : { identifier: input.identifier }),
        ...(input.timestamp === undefined
          ? {}
          : { timestamp: input.timestamp }),
      });
      return {
        dryRun: false,
        identifier: event.identifier,
        eventName: event.event_name,
        value: input.value,
      };
    } catch (error) {
      throw toVendorError("usage", error);
    }
  }

  async portal(input: PortalInput): Promise<PortalResult> {
    const customer = assertNonEmpty(input.customerId, "customer id");
    const returnUrl =
      input.returnUrl === undefined
        ? undefined
        : assertUrl(input.returnUrl, "return url");
    try {
      const session = await this.client.billingPortal.sessions.create({
        customer,
        ...(returnUrl === undefined ? {} : { return_url: returnUrl }),
      });
      return { dryRun: false, url: session.url };
    } catch (error) {
      throw toVendorError("portal", error);
    }
  }

}

export interface WebhookVerifyOptions {
  toleranceSec?: number;
  nowSec?: number;
}

export function assertValidWebhookSignature(
  rawBody: string,
  signature: string | null,
  webhookSecret: string,
  options: WebhookVerifyOptions = {},
): void {
  const secret = assertNonEmpty(webhookSecret, "webhook secret");
  if (signature === null || signature.length === 0) {
    throw new BillingError("webhook request carries no Stripe-Signature");
  }
  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const part of signature.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") timestamp = value;
    else if (key === "v1" && value.length > 0) candidates.push(value);
  }
  if (timestamp === undefined || candidates.length === 0) {
    throw new VendorError("stripe webhook signature has no t or v1 part");
  }
  const tolerance = options.toleranceSec ?? 300;
  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  const seen = Number(timestamp);
  if (!Number.isFinite(seen) || Math.abs(now - seen) > tolerance) {
    throw new VendorError("stripe webhook signature is outside tolerance");
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const match = candidates.some((candidate) => {
    const a = Buffer.from(candidate, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!match) {
    throw new VendorError("stripe webhook signature does not match");
  }
}

export function verifyWebhookEnvelope(
  rawBody: string,
  signature: string | null,
  webhookSecret: string,
  options: WebhookVerifyOptions = {},
): WebhookEnvelope {
  assertValidWebhookSignature(rawBody, signature, webhookSecret, options);
  return parseWebhookEnvelope(rawBody);
}

export class DryRunBillingAdapter implements BillingAdapter {
  readonly name = "dry-run";

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    const price = assertNonEmpty(input.priceId, "price id");
    assertPositiveInt(input.quantity ?? 1, "quantity");
    assertUrl(input.successUrl, "success url");
    assertUrl(input.cancelUrl, "cancel url");
    if (input.customerEmail !== undefined) assertEmail(input.customerEmail);
    if (input.trialDays !== undefined) {
      assertNonNegativeInt(input.trialDays, "trial days");
    }
    return {
      dryRun: true,
      sessionId: dryId("cs", `${price}:${input.customerEmail ?? ""}`),
      url: null,
      mode: "subscription",
    };
  }

  async subscribe(input: SubscribeInput): Promise<SubscriptionResult> {
    const priceId = assertNonEmpty(input.priceId, "price id");
    const quantity = assertPositiveInt(input.quantity ?? 1, "quantity");
    const trialDays =
      input.trialDays === undefined
        ? 0
        : assertNonNegativeInt(input.trialDays, "trial days");
    if (input.customerId === undefined && input.customerEmail === undefined) {
      throw new BillingError("subscribe needs a customer id or an email");
    }
    if (input.customerEmail !== undefined) assertEmail(input.customerEmail);
    const seed = `${input.customerId ?? input.customerEmail}:${priceId}:${quantity}`;
    return {
      dryRun: true,
      customerId:
        input.customerId?.trim() || dryId("cus", seed),
      subscriptionId: dryId("sub", seed),
      status: trialDays > 0 ? "trialing" : "active",
      priceId,
      quantity,
      trialEnd:
        trialDays > 0
          ? new Date(Date.now() + trialDays * 86_400_000).toISOString()
          : null,
    };
  }

  async status(subscriptionId: string): Promise<StatusResult> {
    const id = assertNonEmpty(subscriptionId, "subscription id");
    return {
      dryRun: true,
      customerId: "unknown",
      subscriptionId: id,
      status: "preview",
      access: {
        decision: "deny",
        reason: "dry run previews no live status",
        status: "preview",
      },
    };
  }

  async cancel(input: CancelInput): Promise<CancelResult> {
    const id = assertNonEmpty(input.subscriptionId, "subscription id");
    return {
      dryRun: true,
      subscriptionId: id,
      status: "canceled",
      canceledAt: new Date().toISOString(),
    };
  }

  async invoice(input: InvoiceInput): Promise<InvoiceResult> {
    assertNonEmpty(input.customerId, "customer id");
    assertPositiveInt(input.quantity ?? 1, "quantity");
    if (
      input.priceId !== undefined &&
      input.amountCents !== undefined
    ) {
      throw new BillingError("invoice takes a price or an amount, not both");
    }
    if (input.priceId === undefined && input.amountCents === undefined) {
      throw new BillingError("invoice needs a price or an amount in cents");
    }
    if (input.amountCents !== undefined) {
      assertNonNegativeInt(input.amountCents, "amount");
    }
    const currency =
      input.currency === undefined ? "usd" : assertCurrency(input.currency);
    return {
      dryRun: true,
      invoiceId: dryId("in", `${input.customerId}:${input.priceId ?? input.amountCents}`),
      status: "draft",
      amountDue: input.amountCents ?? 0,
      currency,
      hostedUrl: null,
    };
  }

  async usage(input: UsageInput): Promise<UsageResult> {
    const eventName = assertNonEmpty(input.eventName, "meter event name");
    const customerId = assertNonEmpty(input.customerId, "customer id");
    if (!Number.isFinite(input.value)) {
      throw new BillingError("usage value must be a finite number");
    }
    return {
      dryRun: true,
      identifier:
        input.identifier ??
        dryId("use", `${eventName}:${customerId}:${input.value}`),
      eventName,
      value: input.value,
    };
  }

  async portal(input: PortalInput): Promise<PortalResult> {
    assertNonEmpty(input.customerId, "customer id");
    if (input.returnUrl !== undefined) assertUrl(input.returnUrl, "return url");
    return { dryRun: true, url: null };
  }
}

export interface CreateBillingAdapterOptions {
  secretKey?: string;
  live?: boolean;
  client?: Stripe;
}

export function createBillingAdapter(
  options: CreateBillingAdapterOptions = {},
): BillingAdapter {
  if (options.live !== true) return new DryRunBillingAdapter();
  const key = (options.secretKey ?? "").trim();
  if (key.length === 0) {
    throw new BillingError("live billing needs STRIPE_SECRET_KEY");
  }
  return new StripeBillingAdapter(
    key,
    options.client === undefined ? {} : { client: options.client },
  );
}

export function billingAdapterForEnv(
  env: Record<string, string | undefined> = process.env,
  live = false,
  client?: Stripe,
): BillingAdapter {
  return createBillingAdapter({
    secretKey: env.STRIPE_SECRET_KEY,
    live,
    client,
  });
}

// Sibling usage API. One call reports metered units for any pack:
// it sends the Stripe meter event, stores the row in the credit
// ledger, and records a session cost entry. A dry run previews
// the Stripe call but still stores the local ledger row and the
// cost entry, since both stay local. The ledger dedups repeats
// on the identifier, so retries stay safe.

export interface PackUsageInput {
  pack: string;
  kind: string;
  customerId: string;
  units: number;
  eventName?: string;
  identifier?: string;
  timestamp?: number;
}

export interface PackUsageResult extends UsageResult {
  pack: string;
  kind: string;
  recordedAt: string;
}

export async function reportPackUsage(
  adapter: BillingAdapter,
  ledger: Ledger,
  input: PackUsageInput,
): Promise<PackUsageResult> {
  const pack = assertNonEmpty(input.pack, "pack name");
  const kind = assertNonEmpty(input.kind, "outreach kind");
  const customerId = assertNonEmpty(input.customerId, "customer id");
  if (!Number.isFinite(input.units)) {
    throw new BillingError("usage units must be a finite number");
  }
  const eventName = input.eventName?.trim() || "outreach_units";
  const sent = await adapter.usage({
    eventName,
    customerId,
    value: input.units,
    identifier: input.identifier,
    timestamp: input.timestamp,
  });
  const recordedAt = new Date().toISOString();
  await ledger.ensureSchema();
  await ledger.recordUsage({
    identifier: sent.identifier,
    eventName: sent.eventName,
    customerId,
    value: input.units,
    recordedAt,
  });
  recordCost({ kind: `usage:${pack}:${kind}`, adapter: adapter.name, units: input.units });
  return { ...sent, pack, kind, recordedAt };
}
