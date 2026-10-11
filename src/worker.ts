import {
  BillingError,
  checkAccess,
  planWebhookEvent,
  resolvePriceId,
  type WebhookObject,
} from "./billing.js";
import { VERSION } from "./version.js";

export interface WorkerEnv {
  PACK_NAME?: string;
  [name: string]: string | undefined;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) return null;
  return body as Record<string, unknown>;
}

function optInt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        pack: env.PACK_NAME ?? "agentic-billing",
        version: VERSION,
      });
    }
    // Preview only. The edge entry spends nothing: it checks shape
    // and catalog keys and stops there. Live calls run server side.
    if (request.method === "POST" && url.pathname === "/preview") {
      const body = asRecord(await readBody(request));
      if (body === null) return json({ error: "body must be JSON" }, 400);
      const { plan, price, quantity, email } = body as {
        plan?: unknown;
        price?: unknown;
        quantity?: unknown;
        email?: unknown;
      };
      const qty = quantity === undefined ? 1 : optInt(quantity);
      if (qty === undefined) {
        return json({ error: "quantity must be an integer of 1 or more" }, 400);
      }
      if (qty < 1) {
        return json({ error: "quantity must be an integer of 1 or more" }, 400);
      }
      if (plan === undefined && price === undefined) {
        return json({ error: "body needs a plan or a price" }, 400);
      }
      try {
        const priceId =
          typeof price === "string"
            ? price
            : resolvePriceId(String(plan), env);
        if (typeof priceId !== "string" || priceId.length === 0) {
          return json({ error: "body needs a plan or a price" }, 400);
        }
        return json({
          dryRun: true,
          priceId,
          quantity: qty,
          email: typeof email === "string" ? email : null,
        });
      } catch (error) {
        if (error instanceof BillingError) {
          return json({ error: error.message }, 400);
        }
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === "/access") {
      const body = asRecord(await readBody(request));
      if (body === null || typeof body.status !== "string") {
        return json({ error: "body needs a status string" }, 400);
      }
      const pastDueGraceDays = optInt(body.pastDueGraceDays);
      const daysPastDue = optInt(body.daysPastDue);
      if (
        (body.pastDueGraceDays !== undefined && pastDueGraceDays === undefined) ||
        (body.daysPastDue !== undefined && daysPastDue === undefined)
      ) {
        return json({ error: "grace and past due days must be integers of 0 or more" }, 400);
      }
      return json(checkAccess(body.status, { pastDueGraceDays, daysPastDue }));
    }
    if (request.method === "POST" && url.pathname === "/webhook-plan") {
      const body = asRecord(await readBody(request));
      if (body === null) return json({ error: "body must be JSON" }, 400);
      const { eventId, id, type, object, livemode } = body as {
        eventId?: unknown;
        id?: unknown;
        type?: unknown;
        object?: unknown;
        livemode?: unknown;
      };
      const resolvedId = eventId ?? id;
      if (typeof resolvedId !== "string" || resolvedId.length === 0) {
        return json({ error: "body needs an event id" }, 400);
      }
      if (typeof type !== "string" || type.length === 0) {
        return json({ error: "body needs an event type" }, 400);
      }
      const record = asRecord(object);
      if (record === null || typeof record.id !== "string") {
        return json({ error: "body needs an object with an id" }, 400);
      }
      return json(
        planWebhookEvent({
          eventId: resolvedId,
          type,
          object: {
            id: record.id,
            customer: record.customer as WebhookObject["customer"],
            subscription: record.subscription as WebhookObject["subscription"],
            status:
              typeof record.status === "string" ? record.status : undefined,
          },
          livemode: livemode === true,
        }),
      );
    }
    return json({ error: "not found" }, 404);
  },
};
