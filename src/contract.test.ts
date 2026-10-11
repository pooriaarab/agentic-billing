import { describe, expect, test } from "vitest";
import type * as Contract from "../agentic-core.js";
import {
  createDryRunResult,
  createGuards,
  createLogger,
  defineBrand,
  dispatchText,
  getCostReport,
  GuardError,
  HttpRouterAdapter,
  LocalRouterAdapter,
  recordCost,
  resetCosts,
  summarizeText,
  VendorError,
} from "./core.js";
import * as pack from "./index.js";

// Each binding below fails typecheck when src/core.ts drifts from the
// frozen contract in agentic-core.d.ts. See docs/agentic-core.md.
const _defineBrand: typeof Contract.defineBrand = defineBrand;
const _createLogger: typeof Contract.createLogger = createLogger;
const _GuardError: typeof Contract.GuardError = GuardError;
const _VendorError: typeof Contract.VendorError = VendorError;
const _createGuards: typeof Contract.createGuards = createGuards;
const _LocalRouterAdapter: typeof Contract.LocalRouterAdapter = LocalRouterAdapter;
const _HttpRouterAdapter: typeof Contract.HttpRouterAdapter = HttpRouterAdapter;
const _recordCost: typeof Contract.recordCost = recordCost;
const _getCostReport: typeof Contract.getCostReport = getCostReport;
const _resetCosts: typeof Contract.resetCosts = resetCosts;
const _createDryRunResult: typeof Contract.createDryRunResult = createDryRunResult;
const _dispatchText: typeof Contract.dispatchText = dispatchText;
const _summarizeText: typeof Contract.summarizeText = summarizeText;

void [
  _defineBrand,
  _createLogger,
  _GuardError,
  _VendorError,
  _createGuards,
  _LocalRouterAdapter,
  _HttpRouterAdapter,
  _recordCost,
  _getCostReport,
  _resetCosts,
  _createDryRunResult,
  _dispatchText,
  _summarizeText,
];

describe("frozen contract", () => {
  test("every contracted export exists at runtime", () => {
    for (const value of [
      defineBrand,
      createLogger,
      GuardError,
      VendorError,
      createGuards,
      LocalRouterAdapter,
      HttpRouterAdapter,
      recordCost,
      getCostReport,
      resetCosts,
      createDryRunResult,
      dispatchText,
      summarizeText,
    ]) {
      expect(value).toBeDefined();
    }
  });

  test("the pack re-exports the frozen core unchanged", () => {
    expect(pack.defineBrand).toBe(defineBrand);
    expect(pack.createLogger).toBe(createLogger);
    expect(pack.GuardError).toBe(GuardError);
    expect(pack.VendorError).toBe(VendorError);
    expect(pack.createGuards).toBe(createGuards);
    expect(pack.LocalRouterAdapter).toBe(LocalRouterAdapter);
    expect(pack.HttpRouterAdapter).toBe(HttpRouterAdapter);
    expect(pack.recordCost).toBe(recordCost);
    expect(pack.getCostReport).toBe(getCostReport);
    expect(pack.resetCosts).toBe(resetCosts);
    expect(pack.createDryRunResult).toBe(createDryRunResult);
    expect(pack.dispatchText).toBe(dispatchText);
    expect(pack.summarizeText).toBe(summarizeText);
  });

  test("brand is frozen and pack shaped", () => {
    expect(Object.isFrozen(pack.DEFAULT_BRAND)).toBe(true);
    expect(pack.DEFAULT_BRAND.command).toBe("agentic-billing");
    expect(pack.DEFAULT_BRAND.keywords).toContain("stripe");
    expect(pack.DEFAULT_BRAND.keywords).toContain("subscriptions");
    expect(pack.DEFAULT_BRAND.keywords).toContain("invoicing");
  });
});
