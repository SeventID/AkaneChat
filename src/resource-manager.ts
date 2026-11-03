export interface ResourceBudget { maxConcurrentJobs: number; maxAgentCalls: number; maxRetries: number; maxJobDurationMs: number; maxOutputChars: number }
export const DEFAULT_RESOURCE_BUDGET: Readonly<ResourceBudget> = Object.freeze({ maxConcurrentJobs: 1, maxAgentCalls: 24, maxRetries: 2, maxJobDurationMs: 30 * 60_000, maxOutputChars: 24_000 });
export function validateResourceBudget(input: Partial<ResourceBudget> = {}): ResourceBudget {
  const value = { ...DEFAULT_RESOURCE_BUDGET, ...input };
  const limits: Record<keyof ResourceBudget, [number, number]> = { maxConcurrentJobs: [1, 4], maxAgentCalls: [1, 64], maxRetries: [0, 5], maxJobDurationMs: [10_000, 2 * 60 * 60_000], maxOutputChars: [1000, 100_000] };
  for (const key of Object.keys(limits) as (keyof ResourceBudget)[]) {
    const [min, max] = limits[key];
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
export function mayRetry(attempts: number, budget: ResourceBudget): boolean { return Number.isInteger(attempts) && attempts >= 0 && attempts <= budget.maxRetries; }
export function isWithinJobBudget(startedAt: number, budget: ResourceBudget, now = Date.now()): boolean { return now - startedAt < budget.maxJobDurationMs; }
