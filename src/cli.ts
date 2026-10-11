#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  getCostReport,
  GuardError,
  recordCost,
  VendorError,
} from "./core.js";
import {
  BillingError,
  checkAccess,
  parseWebhookEnvelope,
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
  verifyWebhookEnvelope,
  type BillingAdapter,
} from "./vendors.js";
import { VERSION } from "./version.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type CliCommand =
  | "checkout"
  | "subscribe"
  | "status"
  | "cancel"
  | "invoice"
  | "usage"
  | "portal"
  | "webhook"
  | "ledger"
  | "policy"
  | "costs"
  | "mcp"
  | "help"
  | "version";

const COMMANDS: readonly string[] = [
  "checkout",
  "subscribe",
  "status",
  "cancel",
  "invoice",
  "usage",
  "portal",
  "webhook",
  "ledger",
  "policy",
  "costs",
  "mcp",
];

const VALUE_FLAGS: Record<string, readonly string[]> = {
  checkout: ["price", "plan", "qty", "email", "success-url", "cancel-url", "trial-days"],
  subscribe: ["customer", "email", "price", "plan", "qty", "trial-days"],
  status: ["sub"],
  cancel: ["sub"],
  invoice: ["customer", "price", "plan", "qty", "amount", "currency", "desc"],
  usage: ["event", "customer", "value", "id", "timestamp"],
  portal: ["customer", "return-url"],
  webhook: ["text", "file", "signature", "secret", "ledger-path"],
  ledger: ["sub", "limit", "ledger-path"],
  policy: ["status", "grace-days", "days-past-due"],
  costs: [],
  mcp: [],
};

const LIVE_COMMANDS: readonly string[] = [
  "checkout",
  "subscribe",
  "status",
  "cancel",
  "invoice",
  "usage",
  "portal",
  "webhook",
  "ledger",
];

export interface CliRequest {
  command: CliCommand;
  live: boolean;
  draft: boolean;
  params: Record<string, string>;
}

export function parseArgs(argv: string[]): CliRequest {
  const request: CliRequest = {
    command: "help",
    live: false,
    draft: false,
    params: {},
  };
  const args = [...argv];
  const first = args.shift();
  if (first === undefined || first === "--help" || first === "-h") {
    return request;
  }
  if (first === "--version" || first === "-V") {
    request.command = "version";
    return request;
  }
  if (!COMMANDS.includes(first)) {
    throw new UsageError(`unknown command "${first}"`);
  }
  request.command = first as CliCommand;
  const allowed = VALUE_FLAGS[first] ?? [];
  while (args.length > 0) {
    const flag = args.shift() as string;
    if (flag === "--live" && LIVE_COMMANDS.includes(first)) {
      request.live = true;
      continue;
    }
    if (flag === "--draft" && first === "invoice") {
      request.draft = true;
      continue;
    }
    if (flag.startsWith("--") && args.length > 0) {
      const name = flag.slice(2);
      if (allowed.includes(name)) {
        request.params[name] = args.shift() as string;
        continue;
      }
    }
    throw new UsageError(`unknown flag "${flag}" for "${first}"`);
  }
  return request;
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): string;
  env: Record<string, string | undefined>;
  makeAdapter(live: boolean): BillingAdapter;
  makeLedger(live: boolean, path?: string): Ledger;
}

function defaultIo(): CliIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    readFile: (path) => readFileSync(path, "utf8"),
    env: process.env,
    makeAdapter: (live) => billingAdapterForEnv(process.env, live),
    makeLedger: (live, path) => ledgerForEnv(process.env, live, path),
  };
}

function helpText(): string {
  const command = DEFAULT_BRAND.command;
  return [
    `${DEFAULT_BRAND.name} ${VERSION}`,
    `${DEFAULT_BRAND.description}`,
    "",
    `Usage: ${command} <command> [flags]`,
    "",
    "Commands:",
    "  checkout --price <id|--plan <k>> --success-url <u> --cancel-url <u>",
    "           [--qty <n>] [--email <e>] [--trial-days <n>] [--live]",
    "  subscribe [--customer <id>|--email <e>] --price <id>|--plan <k>",
    "           [--qty <n>] [--trial-days <n>] [--live]",
    "  status --sub <id> [--live]",
    "  cancel --sub <id> [--live]",
    "  invoice --customer <id> (--price <id>|--plan <k>|--amount <c>)",
    "           [--qty <n>] [--currency <c>] [--desc <t>] [--draft] [--live]",
    "  usage --event <name> --customer <id> --value <n> [--id <s>] [--live]",
    "  portal --customer <id> [--return-url <u>] [--live]",
    "  webhook --text <json>|--file <p> [--signature <s>] [--secret <s>]",
    "           [--ledger-path <p>] [--live]",
    "  ledger [--sub <id>] [--limit <n>] [--ledger-path <p>] [--live]",
    "  policy --status <s> [--grace-days <n>] [--days-past-due <n>]",
    "  costs                                      Print the cost report as JSON.",
    "  mcp                                        Start the MCP server on stdio.",
    "",
    "Preview is the default. It needs no keys and spends nothing.",
    "Pass --live to call Stripe or D1 for real.",
    "",
    "Flags:",
    "  --help, -h       Print this help.",
    "  --version, -V    Print the version.",
  ].join("\n");
}

function need(params: Record<string, string>, name: string, command: string): string {
  const value = params[name];
  if (value === undefined || value.length === 0) {
    throw new UsageError(`${command} needs --${name}`);
  }
  return value;
}

function num(
  params: Record<string, string>,
  name: string,
  options: { integer?: boolean; min?: number } = {},
): number | undefined {
  const raw = params[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(`--${name} needs a number, got "${raw}"`);
  }
  if (options.integer === true && !Number.isInteger(value)) {
    throw new UsageError(`--${name} needs an integer, got "${raw}"`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new UsageError(`--${name} needs ${options.min} or more, got "${raw}"`);
  }
  return value;
}

function priceFor(
  params: Record<string, string>,
  command: string,
  env: Record<string, string | undefined>,
  required: boolean,
): string | undefined {
  if (params.price !== undefined) return params.price;
  if (params.plan !== undefined) {
    return resolvePriceId(params.plan, env);
  }
  if (required) {
    throw new UsageError(`${command} needs --price or --plan`);
  }
  return undefined;
}

function trackLiveCost(live: boolean, units: number): void {
  if (!live) return;
  recordCost({ kind: "billing", adapter: "stripe", units });
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let request: CliRequest;
  try {
    request = parseArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(`Run "${DEFAULT_BRAND.command} --help" for usage.`);
    return 2;
  }
  try {
    switch (request.command) {
      case "help":
        io.out(helpText());
        return 0;
      case "version":
        io.out(VERSION);
        return 0;
      case "costs":
        io.out(JSON.stringify(getCostReport()));
        return 0;
      case "policy": {
        const status = need(request.params, "status", "policy");
        io.out(
          JSON.stringify(
            checkAccess(status, {
              pastDueGraceDays: num(request.params, "grace-days", {
                integer: true,
                min: 0,
              }),
              daysPastDue: num(request.params, "days-past-due", {
                integer: true,
                min: 0,
              }),
            }),
          ),
        );
        return 0;
      }
      case "mcp": {
        const { startMcp } = await import("./mcp.js");
        await startMcp({
          makeAdapter: io.makeAdapter,
          makeLedger: io.makeLedger,
        });
        return 0;
      }
      case "checkout": {
        const adapter = io.makeAdapter(request.live);
        const qty = num(request.params, "qty", { integer: true, min: 1 }) ?? 1;
        const result = await adapter.checkout({
          priceId: priceFor(request.params, "checkout", io.env, true) as string,
          quantity: qty,
          customerEmail: request.params.email,
          successUrl: need(request.params, "success-url", "checkout"),
          cancelUrl: need(request.params, "cancel-url", "checkout"),
          trialDays: num(request.params, "trial-days", { integer: true, min: 0 }),
        });
        trackLiveCost(request.live, qty);
        io.out(JSON.stringify(result));
        return 0;
      }
      case "subscribe": {
        const adapter = io.makeAdapter(request.live);
        const qty = num(request.params, "qty", { integer: true, min: 1 }) ?? 1;
        const result = await adapter.subscribe({
          customerId: request.params.customer,
          customerEmail: request.params.email,
          priceId: priceFor(request.params, "subscribe", io.env, true) as string,
          quantity: qty,
          trialDays: num(request.params, "trial-days", { integer: true, min: 0 }),
        });
        trackLiveCost(request.live, qty);
        io.out(JSON.stringify(result));
        return 0;
      }
      case "status": {
        const adapter = io.makeAdapter(request.live);
        const result = await adapter.status(need(request.params, "sub", "status"));
        io.out(JSON.stringify(result));
        return 0;
      }
      case "cancel": {
        const adapter = io.makeAdapter(request.live);
        const result = await adapter.cancel({
          subscriptionId: need(request.params, "sub", "cancel"),
        });
        trackLiveCost(request.live, 1);
        io.out(JSON.stringify(result));
        return 0;
      }
      case "invoice": {
        const adapter = io.makeAdapter(request.live);
        const qty = num(request.params, "qty", { integer: true, min: 1 }) ?? 1;
        const result = await adapter.invoice({
          customerId: need(request.params, "customer", "invoice"),
          priceId: priceFor(request.params, "invoice", io.env, false),
          quantity: qty,
          amountCents: num(request.params, "amount", { integer: true, min: 0 }),
          currency: request.params.currency,
          description: request.params.desc,
          draft: request.draft,
        });
        trackLiveCost(request.live, qty);
        io.out(JSON.stringify(result));
        return 0;
      }
      case "usage": {
        const adapter = io.makeAdapter(request.live);
        const rawValue = need(request.params, "value", "usage");
        const value = Number(rawValue);
        if (!Number.isFinite(value)) {
          throw new UsageError(`--value needs a number, got "${rawValue}"`);
        }
        const result = await adapter.usage({
          eventName: need(request.params, "event", "usage"),
          customerId: need(request.params, "customer", "usage"),
          value,
          identifier: request.params.id,
          timestamp: num(request.params, "timestamp", { integer: true, min: 0 }),
        });
        trackLiveCost(request.live, value);
        io.out(JSON.stringify(result));
        return 0;
      }
      case "portal": {
        const adapter = io.makeAdapter(request.live);
        const result = await adapter.portal({
          customerId: need(request.params, "customer", "portal"),
          returnUrl: request.params["return-url"],
        });
        io.out(JSON.stringify(result));
        return 0;
      }
      case "webhook": {
        const raw =
          request.params.file !== undefined
            ? io.readFile(request.params.file)
            : request.params.text;
        if (raw === undefined) {
          throw new UsageError("webhook needs --text or --file");
        }
        const signature = request.params.signature ?? null;
        const secret =
          request.params.secret ?? io.env.STRIPE_WEBHOOK_SECRET ?? "";
        const envelope =
          signature === null
            ? parseWebhookEnvelope(raw)
            : verifyWebhookEnvelope(raw, signature, secret);
        const plan = planWebhookEvent({
          eventId: envelope.id,
          type: envelope.type,
          object: envelope.object,
          livemode: envelope.livemode,
        });
        if (!plan.handled) {
          io.out(JSON.stringify({ verified: signature !== null, plan }));
          return 0;
        }
        const ledgerPath = request.params["ledger-path"] ?? (request.live ? undefined : defaultLedgerPath());
        const ledger = io.makeLedger(request.live, ledgerPath);
        await ledger.ensureSchema();
        const applied: string[] = [];
        for (const op of plan.ops) {
          if (op.op === "recordEvent") {
            const { duplicate } = await ledger.recordEvent({
              eventId: op.eventId,
              type: op.type,
              customerId: op.customerId,
              subscriptionId: op.subscriptionId,
              livemode: op.livemode,
              receivedAt: new Date().toISOString(),
            });
            applied.push(duplicate ? "recordEvent:duplicate" : "recordEvent:stored");
            if (duplicate) break;
          } else {
            await ledger.upsertSubscription({
              customerId: op.customerId,
              subscriptionId: op.subscriptionId,
              status: op.status,
              priceId: "",
              quantity: 1,
              trialEnd: null,
              livemode: op.livemode,
            });
            applied.push("upsertSubscription:stored");
          }
        }
        if (ledger instanceof MemoryLedger && ledgerPath !== undefined) {
          ledger.save(ledgerPath);
        }
        io.out(JSON.stringify({ verified: signature !== null, plan, applied }));
        return 0;
      }
      case "ledger": {
        const ledgerPath = request.params["ledger-path"] ?? (request.live ? undefined : defaultLedgerPath());
        const ledger = io.makeLedger(request.live, ledgerPath);
        await ledger.ensureSchema();
        if (request.params.sub !== undefined) {
          const sub = await ledger.getSubscription(request.params.sub);
          io.out(JSON.stringify(sub));
          return 0;
        }
        const limit =
          num(request.params, "limit", { integer: true, min: 1 }) ?? 20;
        io.out(JSON.stringify(await ledger.recentEvents(limit)));
        return 0;
      }
    }
  } catch (error) {
    if (
      error instanceof GuardError ||
      error instanceof VendorError ||
      error instanceof UsageError ||
      error instanceof BillingError
    ) {
      io.err(`${error.name}: ${error.message}`);
      return 1;
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      io.err(`file not found: ${request.params.file ?? ""}`);
      return 1;
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // Exit nonzero at once. On zero, fall off the end so a running
      // server (mcp) keeps its stdio handles open. Plain commands
      // hold no handles and exit 0 on their own.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
