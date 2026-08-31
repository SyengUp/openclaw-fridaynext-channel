import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const requireSdk = createRequire(import.meta.url);

export type SessionTranscriptEventLoader = (params: {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}) => unknown[];

export type FridayAgentForwardRuntime = {
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  /**
   * COMPAT(openclaw<2026.8.1): whole-store JSON map. 2026.8.1+ may omit this
   * from `api.runtime.agent.session` (SQLite row APIs replaced it).
   */
  loadSessionStore?: (
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
    /** 2026.8.1+: skip writable DB lifecycle; safe for GET/introspection. */
    readOnly?: boolean;
  }) => Array<{ sessionKey: string; entry: Record<string, unknown> }>;
  /**
   * SQLite transcript rows (2026.8.1+). Optional: older hosts keep JSONL files
   * and this export does not exist.
   */
  loadTranscriptEventsSync?: SessionTranscriptEventLoader;
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

/**
 * Bind the 2026.8.1 SQLite transcript reader. `api.runtime.agent.session` does
 * not expose it — it lives on `plugin-sdk/session-store-runtime`. Skip the host
 * require under Vitest so unit tests cannot accidentally read this machine's
 * live OpenClaw install.
 */
function resolveLoadTranscriptEventsSync(
  session: Record<string, unknown>,
): SessionTranscriptEventLoader | undefined {
  if (typeof session.loadTranscriptEventsSync === "function") {
    return session.loadTranscriptEventsSync as SessionTranscriptEventLoader;
  }
  if (process.env.VITEST === "true") return undefined;
  try {
    const mod = requireSdk("openclaw/plugin-sdk/session-store-runtime") as {
      loadTranscriptEventsSync?: SessionTranscriptEventLoader;
    };
    return typeof mod.loadTranscriptEventsSync === "function"
      ? mod.loadTranscriptEventsSync
      : undefined;
  } catch {
    return undefined;
  }
}

/** Called from `registerFull` so terminal lifecycle forwards can read the session store after persist. */
export function setFridayAgentForwardRuntime(api: OpenClawPluginApi): void {
  const session = api.runtime.agent.session as Record<string, unknown>;
  forwardRuntime = {
    resolveStorePath: api.runtime.agent.session.resolveStorePath,
    loadSessionStore: api.runtime.agent.session.loadSessionStore,
    updateSessionStoreEntry: session.updateSessionStoreEntry as FridayAgentForwardRuntime["updateSessionStoreEntry"],
    getSessionEntry: session.getSessionEntry as FridayAgentForwardRuntime["getSessionEntry"],
    listSessionEntries: session.listSessionEntries as FridayAgentForwardRuntime["listSessionEntries"],
    loadTranscriptEventsSync: resolveLoadTranscriptEventsSync(session),
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
