export interface ParallelAgentSpec { id: string; role: string; prompt: string }
export interface ParallelAgentResult { id: string; role: string; status: "succeeded" | "failed"; output: string; durationMs: number }

/** Runs independent read-only specialist calls concurrently with a hard concurrency cap. */
export async function runParallelAgents<T>(
  agents: readonly ParallelAgentSpec[],
  execute: (agent: ParallelAgentSpec, signal: AbortSignal) => Promise<T>,
  options: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<Array<{ agent: ParallelAgentSpec; status: "succeeded" | "failed"; value?: T; error?: string; durationMs: number }>> {
  const concurrency = Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 2)));
  const results: Array<{ agent: ParallelAgentSpec; status: "succeeded" | "failed"; value?: T; error?: string; durationMs: number }> = new Array(agents.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      if (options.signal?.aborted) return;
      const index = cursor++;
      if (index >= agents.length) return;
      const agent = agents[index]!;
      const started = Date.now();
      try {
        const value = await execute(agent, options.signal ?? new AbortController().signal);
        results[index] = { agent, status: "succeeded", value, durationMs: Date.now() - started };
      } catch (error) {
        results[index] = { agent, status: "failed", error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, agents.length) }, worker));
  return results.filter((item): item is NonNullable<typeof item> => Boolean(item));
}
