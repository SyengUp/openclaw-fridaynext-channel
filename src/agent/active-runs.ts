/** Tracks agent runs that have emitted lifecycle `phase: start` without matching `end`/`error`. */

const active = new Set<string>();

export function observeAgentEventForActiveRuns(evt: {
  stream: string;
  runId: string;
  data: Record<string, unknown>;
}): void {
  if (evt.stream !== "lifecycle") return;
  const phase = evt.data.phase;
  if (phase === "start") active.add(evt.runId);
  if (phase === "end" || phase === "error") active.delete(evt.runId);
}

export function getActiveRunIds(): string[] {
  return [...active];
}

export function getActiveRunCount(): number {
  return active.size;
}

export function resetActiveRunsForTest(): void {
  active.clear();
}
