// Billing ledger. It stores subscription state, webhook events, and
// usage records. MemoryLedger keeps them in memory with an optional
// JSON file. D1Ledger keeps them in Cloudflare D1 over the REST API.
// Both throw VendorError on failure, never silent success.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VendorError } from "./core.js";
import { BillingError } from "./billing.js";

export interface LedgerSubscription {
  customerId: string;
  subscriptionId: string;
  status: string;
  priceId: string;
  quantity: number;
  trialEnd: string | null;
  livemode: boolean;
  updatedAt: string;
}

export interface LedgerEvent {
  eventId: string;
  type: string;
  customerId?: string;
  subscriptionId?: string;
  livemode: boolean;
  receivedAt: string;
}

export interface LedgerUsage {
  identifier: string;
  eventName: string;
  customerId: string;
  value: number;
  recordedAt: string;
}

export interface Ledger {
  readonly name: string;
  ensureSchema(): Promise<void>;
  recordEvent(event: LedgerEvent): Promise<{ duplicate: boolean }>;
  upsertSubscription(sub: Omit<LedgerSubscription, "updatedAt">): Promise<void>;
  getSubscription(subscriptionId: string): Promise<LedgerSubscription | null>;
  recordUsage(usage: LedgerUsage): Promise<void>;
  recentEvents(limit?: number): Promise<LedgerEvent[]>;
}

export const LEDGER_SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS billing_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, subscription_id TEXT, customer_id TEXT, livemode INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS billing_subscriptions (subscription_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL, price_id TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL DEFAULT 1, trial_end TEXT, livemode INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS billing_usage (identifier TEXT PRIMARY KEY, event_name TEXT NOT NULL, customer_id TEXT NOT NULL, value REAL NOT NULL, recorded_at TEXT NOT NULL)",
].join("; ");

export function defaultLedgerPath(): string {
  return join(homedir(), ".agentic-billing", "ledger.json");
}

interface LedgerFile {
  version: 1;
  events: LedgerEvent[];
  subscriptions: LedgerSubscription[];
  usage: LedgerUsage[];
}

export class MemoryLedger implements Ledger {
  readonly name = "memory";
  private readonly events = new Map<string, LedgerEvent>();
  private readonly subscriptions = new Map<string, LedgerSubscription>();
  private readonly usage = new Map<string, LedgerUsage>();

  async ensureSchema(): Promise<void> {
    return undefined;
  }

  async recordEvent(event: LedgerEvent): Promise<{ duplicate: boolean }> {
    if (this.events.has(event.eventId)) return { duplicate: true };
    this.events.set(event.eventId, { ...event });
    return { duplicate: false };
  }

  async upsertSubscription(
    sub: Omit<LedgerSubscription, "updatedAt">,
  ): Promise<void> {
    this.subscriptions.set(sub.subscriptionId, {
      ...sub,
      updatedAt: new Date().toISOString(),
    });
  }

  async getSubscription(
    subscriptionId: string,
  ): Promise<LedgerSubscription | null> {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  async recordUsage(usage: LedgerUsage): Promise<void> {
    this.usage.set(usage.identifier, { ...usage });
  }

  async recentEvents(limit = 20): Promise<LedgerEvent[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return [...this.events.values()]
      .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
      .slice(0, capped)
      .map((event) => ({ ...event }));
  }

  snapshot(): LedgerFile {
    return {
      version: 1,
      events: [...this.events.values()],
      subscriptions: [...this.subscriptions.values()],
      usage: [...this.usage.values()],
    };
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.snapshot(), null, 2));
  }

  load(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    let file: unknown;
    try {
      file = JSON.parse(raw) as unknown;
    } catch {
      throw new BillingError(`ledger file ${path} holds no valid JSON`);
    }
    if (typeof file !== "object" || file === null) {
      throw new BillingError(`ledger file ${path} holds no valid JSON`);
    }
    const { events, subscriptions, usage } = file as Partial<LedgerFile>;
    this.events.clear();
    this.subscriptions.clear();
    this.usage.clear();
    for (const event of events ?? []) this.events.set(event.eventId, event);
    for (const sub of subscriptions ?? []) {
      this.subscriptions.set(sub.subscriptionId, sub);
    }
    for (const entry of usage ?? []) this.usage.set(entry.identifier, entry);
  }
}

export function loadFileLedger(path: string): MemoryLedger {
  const ledger = new MemoryLedger();
  ledger.load(path);
  return ledger;
}

type D1Params = Array<string | number | null>;

interface D1ResultSet {
  results?: Array<Record<string, unknown>>;
  meta?: { changes?: number };
}

interface D1Response {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result?: D1ResultSet[];
}

export interface D1LedgerOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  fetchFn?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

export class D1Ledger implements Ledger {
  readonly name = "d1";
  private readonly accountId: string;
  private readonly databaseId: string;
  private readonly apiToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: D1LedgerOptions) {
    const accountId = options.accountId.trim();
    const databaseId = options.databaseId.trim();
    const apiToken = options.apiToken.trim();
    if (accountId.length === 0 || databaseId.length === 0) {
      throw new BillingError("D1 ledger needs an account id and a database id");
    }
    if (apiToken.length === 0) {
      throw new BillingError("D1 ledger needs an API token");
    }
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.endpoint =
      options.endpoint ?? "https://api.cloudflare.com/client/v4";
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private url(): string {
    return `${this.endpoint}/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
  }

  private async query(
    sql: string,
    params: D1Params = [],
  ): Promise<D1ResultSet> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new VendorError(`d1 ledger request failed: ${String(error)}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new VendorError(
        `d1 ledger got status ${response.status}`,
        { status: response.status },
      );
    }
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch (error) {
      throw new VendorError("d1 ledger returned no JSON body", {
        cause: error,
      });
    }
    if (
      typeof body !== "object" ||
      body === null ||
      (body as D1Response).success !== true ||
      !Array.isArray((body as D1Response).result) ||
      (body as D1Response).result?.length === 0
    ) {
      const firstError = (body as D1Response).errors?.[0]?.message;
      throw new VendorError(
        `d1 ledger query failed${firstError ? `: ${firstError}` : ""}`,
      );
    }
    return (body as D1Response).result?.[0] ?? {};
  }

  async ensureSchema(): Promise<void> {
    await this.query(LEDGER_SCHEMA_SQL);
  }

  async recordEvent(event: LedgerEvent): Promise<{ duplicate: boolean }> {
    const set = await this.query(
      "INSERT OR IGNORE INTO billing_events (event_id, type, subscription_id, customer_id, livemode, received_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        event.eventId,
        event.type,
        event.subscriptionId ?? null,
        event.customerId ?? null,
        event.livemode ? 1 : 0,
        event.receivedAt,
      ],
    );
    return { duplicate: (set.meta?.changes ?? 1) === 0 };
  }

  async upsertSubscription(
    sub: Omit<LedgerSubscription, "updatedAt">,
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.query(
      "INSERT INTO billing_subscriptions (subscription_id, customer_id, status, price_id, quantity, trial_end, livemode, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subscription_id) DO UPDATE SET customer_id = excluded.customer_id, status = excluded.status, price_id = excluded.price_id, quantity = excluded.quantity, trial_end = excluded.trial_end, livemode = excluded.livemode, updated_at = excluded.updated_at",
      [
        sub.subscriptionId,
        sub.customerId,
        sub.status,
        sub.priceId,
        sub.quantity,
        sub.trialEnd,
        sub.livemode ? 1 : 0,
        updatedAt,
      ],
    );
  }

  async getSubscription(
    subscriptionId: string,
  ): Promise<LedgerSubscription | null> {
    const set = await this.query(
      "SELECT subscription_id, customer_id, status, price_id, quantity, trial_end, livemode, updated_at FROM billing_subscriptions WHERE subscription_id = ? LIMIT 1",
      [subscriptionId],
    );
    const row = set.results?.[0];
    if (row === undefined) return null;
    return {
      subscriptionId: String(row.subscription_id ?? ""),
      customerId: String(row.customer_id ?? ""),
      status: String(row.status ?? ""),
      priceId: String(row.price_id ?? ""),
      quantity:
        typeof row.quantity === "number" ? row.quantity : Number(row.quantity ?? 0),
      trialEnd:
        row.trial_end === null || row.trial_end === undefined
          ? null
          : String(row.trial_end),
      livemode: Number(row.livemode ?? 0) === 1,
      updatedAt: String(row.updated_at ?? ""),
    };
  }

  async recordUsage(usage: LedgerUsage): Promise<void> {
    await this.query(
      "INSERT OR IGNORE INTO billing_usage (identifier, event_name, customer_id, value, recorded_at) VALUES (?, ?, ?, ?, ?)",
      [
        usage.identifier,
        usage.eventName,
        usage.customerId,
        usage.value,
        usage.recordedAt,
      ],
    );
  }

  async recentEvents(limit = 20): Promise<LedgerEvent[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const set = await this.query(
      "SELECT event_id, type, subscription_id, customer_id, livemode, received_at FROM billing_events ORDER BY received_at DESC LIMIT ?",
      [capped],
    );
    return (set.results ?? []).map((row) => ({
      eventId: String(row.event_id ?? ""),
      type: String(row.type ?? ""),
      subscriptionId:
        row.subscription_id === null || row.subscription_id === undefined
          ? undefined
          : String(row.subscription_id),
      customerId:
        row.customer_id === null || row.customer_id === undefined
          ? undefined
          : String(row.customer_id),
      livemode: Number(row.livemode ?? 0) === 1,
      receivedAt: String(row.received_at ?? ""),
    }));
  }
}

export function ledgerForEnv(
  env: Record<string, string | undefined> = process.env,
  live = false,
  path?: string,
): Ledger {
  if (live) {
    const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
    const databaseId = (env.CLOUDFLARE_D1_DATABASE_ID ?? "").trim();
    const apiToken = (env.CLOUDFLARE_API_TOKEN ?? "").trim();
    if (!accountId || !databaseId || !apiToken) {
      throw new BillingError(
        "live ledger needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN",
      );
    }
    return new D1Ledger({ accountId, databaseId, apiToken });
  }
  if (path !== undefined) return loadFileLedger(path);
  return new MemoryLedger();
}
