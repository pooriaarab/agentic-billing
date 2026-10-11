import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createLogger,
  getCostReport,
  recordCost,
  VendorError,
  type Logger,
} from "./core.js";
import {
  BillingError,
  checkAccess,
  planWebhookEvent,
  resolvePriceId,
} from "./billing.js";
import { DEFAULT_BRAND } from "./index.js";
import {
  defaultLedgerPath,
  ledgerForEnv,
  MemoryLedger,
  type Ledger,
} from "./ledger.js";
import {
  billingAdapterForEnv,
  type BillingAdapter,
} from "./vendors.js";

export interface McpDeps {
  makeAdapter?: (live: boolean) => BillingAdapter;
  makeLedger?: (live: boolean, path?: string) => Ledger;
  ledgerPath?: string;
  env?: Record<string, string | undefined>;
  logger?: Logger;
}

function errorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function okResult(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const dryRunField = z
  .boolean()
  .optional()
  .describe("Preview only. True previews, false runs live.");

const liveField = z
  .boolean()
  .optional()
  .describe("Read the D1 ledger. False reads the file ledger.");

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const ledgerPath = deps.ledgerPath ?? defaultLedgerPath();
  const makeAdapter =
    deps.makeAdapter ?? ((live: boolean) => billingAdapterForEnv(env, live));
  const makeLedger =
    deps.makeLedger ?? ((live: boolean, path?: string) => ledgerForEnv(env, live, path));
  const logger = deps.logger ?? createLogger({ quiet: true });
  const adapters = new Map<boolean, BillingAdapter>();
  const ledgers = new Map<
    boolean,
    { ledger: Ledger; save: () => void }
  >();

  const forAdapter = (dryRun: boolean | undefined): BillingAdapter => {
    const live = dryRun === false;
    let adapter = adapters.get(live);
    if (adapter === undefined) {
      adapter = makeAdapter(live);
      adapters.set(live, adapter);
    }
    return adapter;
  };

  const forLedger = (liveFlag: boolean | undefined) => {
    const live = liveFlag === true;
    let entry = ledgers.get(live);
    if (entry === undefined) {
      const ledger = makeLedger(live, live ? undefined : ledgerPath);
      entry = {
        ledger,
        save: () => {
          if (!live && ledger instanceof MemoryLedger) ledger.save(ledgerPath);
        },
      };
      ledgers.set(live, entry);
    }
    return entry;
  };

  const priceIdFor = (
    priceId: string | undefined,
    plan: string | undefined,
    command: string,
    required: boolean,
  ): string | undefined => {
    if (priceId !== undefined) return priceId;
    if (plan !== undefined) return resolvePriceId(plan, env);
    if (required) throw new BillingError(`${command} needs a price id or a plan`);
    return undefined;
  };

  const trackCost = (dryRun: boolean | undefined, units: number): void => {
    if (dryRun === false) recordCost({ kind: "billing", adapter: "stripe", units });
  };

  const server = new McpServer({
    name: DEFAULT_BRAND.command,
    version: DEFAULT_BRAND.version,
  });

  server.registerTool(
    "billing_checkout",
    {
      description: "Build a subscription checkout session. Dry run previews it.",
      inputSchema: {
        priceId: z.string().optional().describe("Stripe price id."),
        plan: z.string().optional().describe("Catalog key that resolves to a price."),
        quantity: z.number().int().min(1).optional().describe("Seats, default 1."),
        customerEmail: z.string().optional().describe("Buyer email."),
        successUrl: z.string().describe("Return URL on success."),
        cancelUrl: z.string().describe("Return URL on cancel."),
        trialDays: z.number().int().min(0).optional().describe("Trial days."),
        dryRun: dryRunField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ priceId, plan, quantity, customerEmail, successUrl, cancelUrl, trialDays, dryRun }) => {
      try {
        const qty = quantity ?? 1;
        const result = await forAdapter(dryRun).checkout({
          priceId: priceIdFor(priceId, plan, "checkout", true) as string,
          quantity: qty,
          customerEmail,
          successUrl,
          cancelUrl,
          trialDays,
        });
        trackCost(dryRun, qty);
        logger.info(`checkout dryRun=${result.dryRun}`);
        return okResult(result);
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "billing_subscribe",
    {
      description: "Create a subscription for a customer. Dry run previews it.",
      inputSchema: {
        customerId: z.string().optional().describe("Stripe customer id."),
        customerEmail: z.string().optional().describe("Email when no customer id."),
        priceId: z.string().optional().describe("Stripe price id."),
        plan: z.string().optional().describe("Catalog key that resolves to a price."),
        quantity: z.number().int().min(1).optional().describe("Seats, default 1."),
        trialDays: z.number().int().min(0).optional().describe("Trial days."),
        dryRun: dryRunField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ customerId, customerEmail, priceId, plan, quantity, trialDays, dryRun }) => {
      try {
        const qty = quantity ?? 1;
        const result = await forAdapter(dryRun).subscribe({
          customerId,
          customerEmail,
          priceId: priceIdFor(priceId, plan, "subscribe", true) as string,
          quantity: qty,
          trialDays,
        });
        trackCost(dryRun, qty);
        logger.info(`subscribe dryRun=${result.dryRun}`);
        return okResult(result);
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "billing_status",
    {
      description: "Read a subscription status with its access check.",
      inputSchema: {
        subscriptionId: z.string().describe("Stripe subscription id."),
        dryRun: dryRunField,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, dryRun }) => {
      try {
        return okResult(await forAdapter(dryRun).status(subscriptionId));
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "billing_cancel",
    {
      description: "Cancel a subscription. Dry run previews it.",
      inputSchema: {
        subscriptionId: z.string().describe("Stripe subscription id."),
        dryRun: dryRunField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ subscriptionId, dryRun }) => {
      try {
        const result = await forAdapter(dryRun).cancel({ subscriptionId });
        trackCost(dryRun, 1);
        logger.info(`cancel dryRun=${result.dryRun}`);
        return okResult(result);
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "billing_invoice",
    {
      description: "Draft or finalize a one-off invoice. Dry run previews it.",
      inputSchema: {
        customerId: z.string().describe("Stripe customer id."),
        priceId: z.string().optional().describe("Stripe price id."),
        plan: z.string().optional().describe("Catalog key that resolves to a price."),
        quantity: z.number().int().min(1).optional().describe("Units, default 1."),
        amountCents: z.number().int().min(0).optional().describe("Amount in cents, no price."),
        currency: z.string().optional().describe("3-letter code, default usd."),
        description: z.string().optional().describe("Line text for amount invoices."),
        draft: z.boolean().optional().describe("True keeps the invoice a draft."),
        dryRun: dryRunField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ customerId, priceId, plan, quantity, amountCents, currency, description, draft, dryRun }) => {
      try {
        const qty = quantity ?? 1;
        const result = await forAdapter(dryRun).invoice({
          customerId,
          priceId: priceIdFor(priceId, plan, "invoice", false),
          quantity: qty,
          amountCents,
          currency,
          description,
          draft,
        });
        trackCost(dryRun, qty);
        logger.info(`invoice dryRun=${result.dryRun}`);
        return okResult(result);
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "billing_usage",
    {
      description: "Report metered units for a customer. Dry run previews it.",
      inputSchema: {
        eventName: z.string().describe("Meter event name on the Stripe meter."),
        customerId: z.string().describe("Stripe customer id."),
        value: z.number().describe("Units to report."),
        identifier: z.string().optional().describe("Idempotency key."),
        dryRun: dryRunField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ eventName, customerId, value, identifier, dryRun }) => {
      try {
        const result = await forAdapter(dryRun).usage({
          eventName,
          customerId,
          value,
          identifier,
        });
        trackCost(dryRun, value);
        logger.info(`usage dryRun=${result.dryRun}`);
        return okResult(result);
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "billing_portal",
    {
      description: "Build a customer billing portal link. Dry run previews it.",
      inputSchema: {
        customerId: z.string().describe("Stripe customer id."),
        returnUrl: z.string().optional().describe("Return URL."),
        dryRun: dryRunField,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ customerId, returnUrl, dryRun }) => {
      try {
        return okResult(await forAdapter(dryRun).portal({ customerId, returnUrl }));
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "billing_webhook_plan",
    {
      description: "Plan the ledger writes one Stripe event needs.",
      inputSchema: {
        eventId: z.string().describe("Stripe event id."),
        type: z.string().describe("Event type."),
        object: z
          .object({
            id: z.string(),
            customer: z.string().optional(),
            subscription: z.string().optional(),
            status: z.string().optional(),
          })
          .describe("The event data object."),
        livemode: z.boolean().optional().describe("True for live events."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ eventId, type, object, livemode }) => {
      try {
        return okResult(
          planWebhookEvent({ eventId, type, object, livemode: livemode ?? false }),
        );
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "ledger_record_event",
    {
      description: "Store one webhook event id so replays stay idempotent.",
      inputSchema: {
        eventId: z.string().describe("Stripe event id."),
        type: z.string().describe("Event type."),
        customerId: z.string().optional(),
        subscriptionId: z.string().optional(),
        livemode: z.boolean().optional(),
        live: liveField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ eventId, type, customerId, subscriptionId, livemode, live }) => {
      try {
        const { ledger, save } = forLedger(live);
        await ledger.ensureSchema();
        const result = await ledger.recordEvent({
          eventId,
          type,
          customerId,
          subscriptionId,
          livemode: livemode ?? false,
          receivedAt: new Date().toISOString(),
        });
        save();
        return okResult(result);
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "ledger_upsert_subscription",
    {
      description: "Store the latest subscription state in the ledger.",
      inputSchema: {
        customerId: z.string(),
        subscriptionId: z.string(),
        status: z.string(),
        priceId: z.string().optional(),
        quantity: z.number().int().min(1).optional(),
        trialEnd: z.string().optional(),
        livemode: z.boolean().optional(),
        live: liveField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ customerId, subscriptionId, status, priceId, quantity, trialEnd, livemode, live }) => {
      try {
        const { ledger, save } = forLedger(live);
        await ledger.ensureSchema();
        await ledger.upsertSubscription({
          customerId,
          subscriptionId,
          status,
          priceId: priceId ?? "",
          quantity: quantity ?? 1,
          trialEnd: trialEnd ?? null,
          livemode: livemode ?? false,
        });
        save();
        return okResult({ stored: true, subscriptionId });
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "ledger_events",
    {
      description: "List recent ledger events, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        live: liveField,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, live }) => {
      try {
        const { ledger } = forLedger(live);
        await ledger.ensureSchema();
        return okResult(await ledger.recentEvents(limit ?? 20));
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "ledger_subscription",
    {
      description: "Read one subscription row from the ledger.",
      inputSchema: {
        subscriptionId: z.string(),
        live: liveField,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ subscriptionId, live }) => {
      try {
        const { ledger } = forLedger(live);
        await ledger.ensureSchema();
        return okResult(await ledger.getSubscription(subscriptionId));
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "billing_policy",
    {
      description: "Check access for a subscription status.",
      inputSchema: {
        status: z.string().describe("Stripe subscription status."),
        pastDueGraceDays: z.number().int().min(0).optional(),
        daysPastDue: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, pastDueGraceDays, daysPastDue }) => {
      try {
        return okResult(checkAccess(status, { pastDueGraceDays, daysPastDue }));
      } catch (error) {
        if (error instanceof BillingError || error instanceof VendorError) {
          return errorResult(error);
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "get_cost_report",
    {
      description: "Read the cost report for this session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => okResult(getCostReport()),
  );

  return server;
}

export async function startMcp(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
