import { describe, expect, test } from "bun:test";
import { DEFAULT_RESOURCE_BUDGET, isWithinJobBudget, mayRetry, validateResourceBudget } from "../src/resource-manager";
describe("resource and safety budgets", () => {
  test("enforces bounded defaults and rejects unsafe values", () => { expect(validateResourceBudget()).toEqual(DEFAULT_RESOURCE_BUDGET); expect(() => validateResourceBudget({ maxConcurrentJobs: 99 })).toThrow(); });
  test("bounds retries and execution duration", () => { expect(mayRetry(2, DEFAULT_RESOURCE_BUDGET)).toBe(true); expect(mayRetry(3, DEFAULT_RESOURCE_BUDGET)).toBe(false); expect(isWithinJobBudget(1000, DEFAULT_RESOURCE_BUDGET, 2000)).toBe(true); });
});
