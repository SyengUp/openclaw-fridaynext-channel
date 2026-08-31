/**
 * PUT /friday-next-admin/agents/identity   body: { agentId, name }
 *
 * Renames an agent through OpenClaw's **canonical** path: the gateway method
 * `agents.update`. That one call does all three writes core does for a rename —
 *   1. the roster entry `.name`             (the list label)
 *   2. the roster entry `.identity.name`    (the identity block)
 *   3. the workspace `IDENTITY.md` `- **Name:**` line (merged, other content kept)
 * — which is exactly what `openclaw agents set-identity` and ControlUI produce.
 * None of those helpers (`updateAgentConfigEntry`, `mergeIdentityMarkdownContent`)
 * are exported through plugin-sdk, so dispatching the method is the only way to
 * get the full behaviour without duplicating core logic. Config-only writes via
 * `mutateConfigFile` would leave IDENTITY.md stale — the agent would keep
 * introducing itself by the old name.
 *
 * Registered under the `/friday-next-admin` sibling prefix with `auth: "gateway"` +
 * `gatewayRuntimeScopeSurface: "trusted-operator"`, same as the session-delete
 * route: `agents.update` requires `operator.admin`, which the shared-secret bearer
 * the app already sends resolves to. Dispatch also requires the manifest's
 * `contracts.gatewayMethodDispatch: ["authenticated-request"]` (already declared).
 *
 * TWO WAYS THE DEFAULT ("main") AGENT DIFFERS — both handled here:
 *
 * (a) `agents.update` rejects agents that aren't in the host roster
 *     (`isConfiguredAgent`). COMPAT(openclaw<2026.8.1): the common `main` is
 *     IMPLICIT — config carries `agents: { defaults: {…} }` and no list at all,
 *     so a bare rename would 400 with `agent "main" not found`. We materialize a
 *     bare roster row first (never `default: true` — that would move default-agent
 *     resolution; on old hosts that row is `{ id }` in `agents.list`, see
 *     `agent-roster.ts`). On OpenClaw ≥2026.8.1 the roster is `agents.entries`
 *     and `main` is usually already present.
 *
 * (b) For the DEFAULT agent, core's `resolveAssistantIdentity` ranks
 *     `ui.assistant.name` ABOVE `identity.name` (non-default agents rank it last).
 *     So if `ui.assistant.name` is set, renaming identity alone changes nothing
 *     for the gateway/ControlUI while the app's own list — which never reads
 *     `ui.assistant` — would show the new name: a split-brain rename. We keep the
 *     override in sync when it exists (we don't create one when it doesn't).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import { isPublicRequest } from "../middleware/public-surface.js";
import { readJsonBody } from "../middleware/body.js";
import { verifySession } from "../../attest/attest-store.js";
import { attestGateDecision, ATTEST_REJECTION_BODY } from "../../attest/attest-gate.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { getUpgradeRuntime } from "../../upgrade-runtime.js";
import { normalizeAgentId } from "../../agent-id.js";
import {
  ensureAgentRosterConfig,
  findAgentRosterConfig,
  resolveRosterDefaultAgentId,
} from "../../agent-roster.js";
import { createFridayNextLogger } from "../../logging.js";

/** Core caps assistant display names at 50 chars (MAX_ASSISTANT_NAME); reject rather than truncate. */
const MAX_AGENT_NAME_CHARS = 50;

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

/** Mirrors core `sanitizeIdentityLine`: identity values are single-line. */
export function sanitizeAgentName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

function statusForErrorCode(code: string | undefined): number {
  switch (code) {
    case "INVALID_REQUEST":
      return 400;
    case "NOT_LINKED":
    case "NOT_PAIRED":
      return 409;
    case "UNAVAILABLE":
      return 503;
    case "AGENT_TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

function readConfig(): Record<string, unknown> | undefined {
  const cfg = getFridayAgentForwardRuntime()?.getConfig();
  return cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : undefined;
}

/** The default agent is the entry flagged `default: true`, else the first one, else `main`. */
function resolveDefaultAgentId(cfg: Record<string, unknown> | undefined): string {
  return resolveRosterDefaultAgentId(cfg);
}

/** `agents.update` 400s on agents with no roster entry — materialize a bare one first.
 * COMPAT(openclaw<2026.8.1): `ensureAgentRosterConfig` writes `agents.list` on old hosts. */
async function ensureAgentListEntry(agentId: string): Promise<void> {
  if (findAgentRosterConfig(readConfig(), agentId)) return;
  const upgrade = getUpgradeRuntime();
  if (!upgrade) throw new Error("Config write runtime unavailable");
  await upgrade.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draftRaw) => {
      ensureAgentRosterConfig(draftRaw as Record<string, unknown>, agentId);
    },
  });
}

/**
 * Keep `ui.assistant.name` in step when it exists and shadows the renamed default agent.
 * Best-effort: a failure here doesn't invalidate the rename that already committed.
 */
async function syncUiAssistantName(agentId: string, name: string): Promise<boolean> {
  const cfg = readConfig();
  if (agentId !== resolveDefaultAgentId(cfg)) return false;
  const ui = cfg?.ui as Record<string, unknown> | undefined;
  const assistant = ui?.assistant as Record<string, unknown> | undefined;
  const current = typeof assistant?.name === "string" ? assistant.name.trim() : "";
  if (!current || current === name) return false;
  const upgrade = getUpgradeRuntime();
  if (!upgrade) return false;
  await upgrade.mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draftRaw) => {
      const draft = draftRaw as Record<string, unknown>;
      const draftUi = draft.ui as Record<string, unknown> | undefined;
      const draftAssistant = draftUi?.assistant as Record<string, unknown> | undefined;
      // Only update an override that is actually there — never create one.
      if (draftAssistant && typeof draftAssistant.name === "string") {
        draftAssistant.name = name;
      }
    },
  });
  return true;
}

export async function handleAgentIdentity(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "PUT") {
    return json(res, 405, { error: "Method Not Allowed" });
  }

  // Same reasoning as session-delete: this route sits outside the `/friday-next`
  // prefix that carries the shared attest gate, yet the filter proxy exposes it
  // publicly — without this a leaked bearer could rename agents from the internet.
  if (isPublicRequest(req)) {
    const attestCfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    const gate = attestGateDecision({
      pathname: "/friday-next-admin/agents/identity",
      headers: req.headers,
      isPublic: true,
      required: attestCfg.appAttest.required,
      scope: "plugin",
      verify: (t) => verifySession(t, Date.now()),
    });
    if (gate === "reject") return json(res, 403, { ...ATTEST_REJECTION_BODY });
  }

  const body = await readJsonBody(req);
  if (!body) return json(res, 400, { error: "Invalid or missing JSON body" });

  // Require the id explicitly: `normalizeAgentId("")` resolves to "main", so an
  // omitted/blank field would silently rename the DEFAULT agent.
  const rawAgentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!rawAgentId) return json(res, 400, { error: "Missing required field: agentId" });
  const agentId = normalizeAgentId(rawAgentId);

  const name = sanitizeAgentName(body.name);
  if (!name) return json(res, 400, { error: "Missing required field: name" });
  if (name.length > MAX_AGENT_NAME_CHARS) {
    return json(res, 400, { error: `name exceeds ${MAX_AGENT_NAME_CHARS} characters` });
  }

  const log = createFridayNextLogger("agent-identity");

  try {
    await ensureAgentListEntry(agentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`failed to materialize agent roster entry for "${agentId}": ${msg}`);
    return json(res, 500, { ok: false, error: "Failed to prepare agent config", detail: msg });
  }

  let response: Awaited<ReturnType<typeof dispatchGatewayMethod>>;
  try {
    response = await dispatchGatewayMethod("agents.update", { agentId, name });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!response.ok) {
    const code = response.error?.code;
    return json(res, statusForErrorCode(code), {
      ok: false,
      error: response.error?.message ?? "agents.update failed",
      ...(code ? { code } : {}),
    });
  }

  let uiAssistantSynced = false;
  try {
    uiAssistantSynced = await syncUiAssistantName(agentId, name);
  } catch (err) {
    // The rename itself already committed; report success and log the shadow.
    log.warn(
      `ui.assistant.name sync failed for "${agentId}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log.info(`agent "${agentId}" renamed to "${name}"`);
  return json(res, 200, { ok: true, agentId, name, uiAssistantSynced });
}
