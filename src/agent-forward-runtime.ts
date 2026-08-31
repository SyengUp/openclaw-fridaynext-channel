import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type FridayAgentForwardRuntime = {
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  loadSessionStore: (
    path: string,
    options?: { skipCache?: boolean; maintenanceConfig?: unknown; clone?: boolean },
  ) => Record<string, unknown>;
  /** Cache-owning entry write (syncs the app session name → server `displayName`). */
  updateSessionStoreEntry?: (params: {
    storePath: string;
    sessionKey: string;
    update: (
      entry: Record<string, unknown>,
    ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  }) => Promise<Record<string, unknown> | null>;
  /**
   * Canonical session-store read (SQLite-first on OpenClaw 2026.8.1+). Optional on
   * older hosts that only expose `loadSessionStore`.
   */
  getSessionEntry?: (params: {
    sessionKey: string;
    agentId?: string;
    storePath?: string;
  }) => Record<string, unknown> | undefined;
  /** Identity-based list; used to resolve Control UI sessionId → store key. */
  listSessionEntries?: (params?: {
    agentId?: string;
    storePath?: string;
  }) => Array<{ sessionKey: string; entry: Record<string, unknown> }>;
  /**
   * Identity-based session patch. Preferred over `updateSessionStoreEntry` for
   * `permissionMode` so the write lands in the canonical store, not legacy JSON.
   */
  patchSessionEntry?: (params: {
    sessionKey: string;
    agentId?: string;
    storePath?: string;
    preserveActivity?: boolean;
    update: (
      entry: Record<string, unknown>,
      context: { existingEntry?: Record<string, unknown> },
    ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  }) => Promise<Record<string, unknown> | null>;
  /** Resolves an agent's workspace dir — used to read IDENTITY.md for the name fallback. */
  resolveAgentWorkspaceDir?: (cfg: unknown, agentId: string) => string;
  /**
   * Resolves the thinking-level options + default for a provider/model pair, driven by the running
   * gateway's provider plugins + model catalog (so the option set varies per model). Optional: older
   * gateways don't expose it, in which case callers fall back to the base five levels.
   */
  resolveThinkingPolicy?: (params: { provider?: string | null; model?: string | null }) => {
    levels: Array<{ id: string; label: string }>;
    defaultLevel?: string | null;
  };
  getConfig: () => unknown;
};

let forwardRuntime: FridayAgentForwardRuntime | null = null;

/** Called from `registerFull` so terminal lifecycle forwards can read `sessions.json` after persist. */
export function setFridayAgentForwardRuntime(api: OpenClawPluginApi): void {
  const session = api.runtime.agent.session as Record<string, unknown>;
  forwardRuntime = {
    resolveStorePath: api.runtime.agent.session.resolveStorePath,
    loadSessionStore: api.runtime.agent.session.loadSessionStore,
    updateSessionStoreEntry: session.updateSessionStoreEntry as FridayAgentForwardRuntime["updateSessionStoreEntry"],
    getSessionEntry: session.getSessionEntry as FridayAgentForwardRuntime["getSessionEntry"],
    listSessionEntries: session.listSessionEntries as FridayAgentForwardRuntime["listSessionEntries"],
    patchSessionEntry: session.patchSessionEntry as FridayAgentForwardRuntime["patchSessionEntry"],
    resolveAgentWorkspaceDir: (api.runtime.agent as Record<string, unknown>)
      .resolveAgentWorkspaceDir as FridayAgentForwardRuntime["resolveAgentWorkspaceDir"],
    resolveThinkingPolicy: (api.runtime.agent as Record<string, unknown>)
      .resolveThinkingPolicy as FridayAgentForwardRuntime["resolveThinkingPolicy"],
    getConfig: () => api.runtime.config.current(),
  };
}

export function getFridayAgentForwardRuntime(): FridayAgentForwardRuntime | null {
  return forwardRuntime;
}

/** Vitest-only */
export function resetFridayAgentForwardRuntimeForTest(): void {
  forwardRuntime = null;
}
