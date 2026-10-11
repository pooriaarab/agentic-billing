import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BillingError } from "./billing.js";
import { parseArgs, runCli, UsageError, type CliIo } from "./cli.js";
import { MemoryLedger } from "./ledger.js";
import { DryRunBillingAdapter } from "./vendors.js";

function testIo(overrides: Partial<CliIo> = {}): CliIo & {
  outLines: string[];
  errLines: string[];
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    readFile: (path) => `file:${path}`,
    env: { BILLING_PRICE_STARTER_MONTHLY: "price_test_123" },
    makeAdapter: () => new DryRunBillingAdapter(),
    makeLedger: () => new MemoryLedger(),
    ...overrides,
  };
}

describe("parseArgs", () => {
  test("empty args print help", () => {
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["--help"]).command).toBe("help");
  });

  test("version flag prints version", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
  });

  test("reads commands and flags", () => {
    const request = parseArgs([
      "subscribe",
      "--email",
      "a@b.co",
      "--plan",
      "starter-monthly",
      "--live",
    ]);
    expect(request).toMatchObject({
      command: "subscribe",
      live: true,
      params: { email: "a@b.co", plan: "starter-monthly" },
    });
  });

  test("rejects unknown commands and flags", () => {
    expect(() => parseArgs(["refund"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "--bogus", "x"])).toThrow(UsageError);
    expect(() => parseArgs(["policy", "--live"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "--sub"])).toThrow(UsageError);
  });
});

describe("runCli", () => {
  test("help and version print", async () => {
    const io = testIo();
    await expect(runCli([], io)).resolves.toBe(0);
    expect(io.outLines.join("\n")).toContain("agentic-billing");
    const io2 = testIo();
    await expect(runCli(["--version"], io2)).resolves.toBe(0);
    expect(io2.outLines[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("unknown command exits 2", async () => {
    const io = testIo();
    await expect(runCli(["refund"], io)).resolves.toBe(2);
    expect(io.errLines[0]).toMatch(/unknown command/);
  });

  test("checkout previews with a plan", async () => {
    const io = testIo();
    const code = await runCli(
      [
        "checkout",
        "--plan",
        "starter-monthly",
        "--success-url",
        "https://example.com/ok",
        "--cancel-url",
        "https://example.com/no",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0])).toMatchObject({ dryRun: true });
  });

  test("subscribe resolves plans and reports config errors", async () => {
    const io = testIo();
    const code = await runCli(
      ["subscribe", "--email", "buyer@example.com", "--plan", "starter-monthly"],
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0])).toMatchObject({
      dryRun: true,
      priceId: "price_test_123",
    });
    const io2 = testIo();
    const code2 = await runCli(
      ["subscribe", "--email", "buyer@example.com"],
      io2,
    );
    expect(code2).toBe(1);
    expect(io2.errLines[0]).toMatch(/needs --price or --plan/);
  });

  test("status, cancel, portal, and usage print JSON", async () => {
    const io = testIo();
    await expect(runCli(["status", "--sub", "sub_1"], io)).resolves.toBe(0);
    expect(JSON.parse(io.outLines[0]).status).toBe("preview");
    await expect(runCli(["cancel", "--sub", "sub_1"], io)).resolves.toBe(0);
    await expect(runCli(["portal", "--customer", "cus_1"], io)).resolves.toBe(0);
    await expect(
      runCli(["usage", "--event", "tokens", "--customer", "cus_1", "--value", "25"], io),
    ).resolves.toBe(0);
    expect(JSON.parse(io.outLines[3])).toMatchObject({ value: 25 });
    const bad = testIo();
    await expect(
      runCli(["usage", "--event", "t", "--customer", "c", "--value", "x"], bad),
    ).resolves.toBe(1);
  });

  test("invoice takes price or amount", async () => {
    const io = testIo();
    await expect(
      runCli(["invoice", "--customer", "cus_1", "--amount", "500"], io),
    ).resolves.toBe(0);
    expect(JSON.parse(io.outLines[0])).toMatchObject({ amountDue: 500 });
    const io2 = testIo();
    await expect(runCli(["invoice", "--customer", "cus_1"], io2)).resolves.toBe(1);
  });

  test("live without a key fails clean", async () => {
    const io = testIo({
      makeAdapter: () => {
        throw new BillingError("live billing needs STRIPE_SECRET_KEY");
      },
    });
    const code = await runCli(["status", "--sub", "sub_1", "--live"], io);
    expect(code).toBe(1);
    expect(io.errLines[0]).toContain("BillingError");
  });

  test("webhook applies a plan to the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-ledger-"));
    const path = join(dir, "ledger.json");
    const shared = new MemoryLedger();
    const io = testIo({ makeLedger: () => shared });
    const raw = JSON.stringify({
      id: "evt_1",
      type: "customer.subscription.updated",
      livemode: false,
      data: { object: { id: "sub_1", customer: "cus_1", status: "active" } },
    });
    const code = await runCli(
      ["webhook", "--text", raw, "--ledger-path", path],
      io,
    );
    expect(code).toBe(0);
    const out = JSON.parse(io.outLines[0]);
    expect(out.verified).toBe(false);
    expect(out.applied).toContain("upsertSubscription:stored");
    expect((await shared.getSubscription("sub_1"))?.status).toBe("active");
    const again = testIo({ makeLedger: () => shared });
    await runCli(["webhook", "--text", raw], again);
    expect(JSON.parse(again.outLines[0]).applied).toEqual([
      "recordEvent:duplicate",
    ]);
  });

  test("webhook verifies signatures when given", async () => {
    const secret = "whsec_test";
    const raw = JSON.stringify({
      id: "evt_9",
      type: "invoice.paid",
      livemode: false,
      data: { object: { id: "in_1", customer: "cus_1" } },
    });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret)
      .update(`${t}.${raw}`, "utf8")
      .digest("hex");
    const io = testIo();
    const code = await runCli(
      ["webhook", "--text", raw, "--signature", `t=${t},v1=${sig}`, "--secret", secret],
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0]).verified).toBe(true);
    const bad = testIo();
    const code2 = await runCli(
      ["webhook", "--text", raw, "--signature", "t=1,v1=dead", "--secret", secret],
      bad,
    );
    expect(code2).toBe(1);
  });

  test("ledger lists events and reads one row", async () => {
    const shared = new MemoryLedger();
    await shared.recordEvent({
      eventId: "evt_1",
      type: "invoice.paid",
      livemode: false,
      receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const io = testIo({ makeLedger: () => shared });
    await expect(runCli(["ledger"], io)).resolves.toBe(0);
    expect(JSON.parse(io.outLines[0])).toHaveLength(1);
    await expect(runCli(["ledger", "--sub", "sub_x"], io)).resolves.toBe(0);
    expect(io.outLines[1]).toBe("null");
  });

  test("policy and costs print JSON", async () => {
    const io = testIo();
    await expect(runCli(["policy", "--status", "past_due"], io)).resolves.toBe(0);
    expect(JSON.parse(io.outLines[0]).decision).toBe("warn");
    await expect(runCli(["costs"], io)).resolves.toBe(0);
    expect(JSON.parse(io.outLines[1])).toHaveProperty("entries");
  });

  test("missing files report clean", async () => {
    const io = testIo({
      readFile: () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    const code = await runCli(["webhook", "--file", "evt.json"], io);
    expect(code).toBe(1);
    expect(io.errLines[0]).toMatch(/file not found/);
  });
});
