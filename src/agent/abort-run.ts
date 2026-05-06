export async function abortRun(runId: string): Promise<void> {
  if (process.env.VITEST !== "true") {
    try {
      const { abortAgentHarnessRun } = await import("openclaw/plugin-sdk/agent-harness");
      abortAgentHarnessRun(runId);
    } catch {
      // optional at runtime
    }
  }
}
