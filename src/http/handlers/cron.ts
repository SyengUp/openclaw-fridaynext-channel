/**
 * Scheduled-task (cron) management for the app.
 *
 *   GET    /friday-next-admin/cron/jobs                → `cron.list`
 *   POST   /friday-next-admin/cron/jobs                → `cron.add`
 *   PATCH  /friday-next-admin/cron/jobs?id=<jobId>     → `cron.update`
 *   DELETE /friday-next-admin/cron/jobs?id=<jobId>     → `cron.remove`
 *   POST   /friday-next-admin/cron/jobs/run            → `cron.run` (mode "force")
 *   GET    /friday-next-admin/cron/runs?jobId=<jobId>  → `cron.runs`
 *   GET    /friday-next-admin/cron/channels            → `channels.status` (reduced)
 *
 * Cron runs INSIDE the gateway process and owns its own SQLite-backed store plus the
 * armed timers, so mutating the store directly (the read-only `loadCronStore` the
 * notifications inbox uses) would leave the scheduler running the old schedule. The
 * canonical methods are the only correct write path — hence dispatch, same as
 * `session-delete.ts` / `agent-identity.ts`.
 *
 * WHY THE `/friday-next-admin` SIBLING PREFIX (not `/friday-next`):
 * `/friday-next` is registered `auth: "plugin"`, and core gives plugin-authed routes a
 * runtime client with an EMPTY operator scope list, so dispatching any scoped method
 * from there is refused. A gateway-authed route cannot overlap that prefix, so these
 * live next door.
 *
 * SCOPES (src/gateway/methods/core-descriptors.ts):
 *   `cron.list` / `cron.get` / `cron.runs`         → operator.read
 *   `cron.add` / `cron.update` / `cron.remove` / `cron.run` → operator.admin
 * So the two mutating routes ask for `gatewayRuntimeScopeSurface: "trusted-operator"`
 * (the shared-secret bearer the app already sends resolves to the full CLI operator
 * scope set) while the read-only run-history route does NOT — the default surface's
 * `operator.write` already satisfies `operator.read`. Least privilege, same call the
 * `commands-list.ts` route makes.
 *
 * WHY `POST` DOES NOT ACCEPT A `payload`:
 * `cron.add` can create `command` jobs — arbitrary argv executed on the gateway host by
 * the scheduler. The app has no use for that, so this route assembles an `agentTurn`
 * payload itself and never forwards a caller-supplied one. `PATCH` likewise whitelists
 * the fields it forwards. A stolen app bearer therefore cannot turn this surface into a
 * remote shell, even though the underlying method would allow it. Command jobs created
 * elsewhere (CLI/ControlUI) still LIST fine — they're just read-only from the app.
 *
 * The delivery block is server-assembled too: `{mode:"announce", channel:"friday-next",
 * to:<deviceId>}`. Pinning `to` to the requesting device is what keeps the notifications
 * inbox's attribution honest (see `notifications/cron-delivery-target.ts`) instead of
 * relying on the channel's sole-connected/last-seen fallback.
 *
 * PATCH accepts delivery edits through a restricted `delivery` patch (`mode:"announce"`
 * with an explicit `channel`, plus `to` as a non-empty string or an explicit `null`
 * meaning "the channel's default target"; or `mode:"none"`) so the app can retarget a
 * job it did not create (e.g. a CLI-made command job announcing to telegram); the
 * legacy bare `deviceId` shorthand still re-pins to friday-next. The two are mutually
 * exclusive. The `/cron/channels` list is what feeds the app's channel picker.
 *
 * Dispatch requires the manifest's `contracts.gatewayMethodDispatch:
 * ["authenticated-request"]` (already declared).
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
import { normalizeAgentId } from "../../agent-id.js";
import { FRIDAY_NEXT_CHANNEL_ID } from "../../notifications/cron-delivery-target.js";
import { createFridayNextLogger } from "../../logging.js";

/** Core clamps `cron.list` / `cron.runs` at 200 per page. */
const MAX_PAGE_LIMIT = 200;

function json(res: ServerResponse, status: number, body: Record<string, unknown>): true {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

/** Maps a gateway error code to an HTTP status (same table as the sibling admin routes). */
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

/**
 * App Attest gate, mirroring `server.ts`'s for `/friday-next/*`: these routes live under a
 * SIBLING prefix so the shared gate never sees them, yet the filter proxy exposes them
 * publicly (`/^\/friday-next-admin(\/|$)/`). Without this a leaked bearer could create a
 * scheduled agent turn from the internet. Gate PUBLIC-marked requests only (the marker is a
 * header — check it before touching the runtime, so LAN requests never need one configured).
 */
function attestRejects(req: IncomingMessage, pathname: string): boolean {
  if (!isPublicRequest(req)) return false;
  const attestCfg = resolveFridayNextConfig(
    getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
  );
  return (
    attestGateDecision({
      pathname,
      headers: req.headers,
      isPublic: true,
      required: attestCfg.appAttest.required,
      scope: "plugin",
      verify: (t) => verifySession(t, Date.now()),
    }) === "reject"
  );
}

/**
 * Dispatches a cron method. On failure the error envelope is already written to `res`
 * (`sent: true`) and the caller just returns; on success the caller shapes the payload,
 * since several cron methods answer `ok: true` with a business-level refusal inside
 * (`{ok:true, ran:false, reason:"already-running"}`, `{ok:true, removed:false}`) that
 * only the caller knows how to map to a status.
 */
type CronDispatchOutcome =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; sent: true };

async function dispatchCron(
  res: ServerResponse,
  method: string,
  params: Record<string, unknown>,
): Promise<CronDispatchOutcome> {
  let response: Awaited<ReturnType<typeof dispatchGatewayMethod>>;
  try {
    response = await dispatchGatewayMethod(method, params);
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, sent: true };
  }
  if (!response.ok) {
    const code = response.error?.code;
    json(res, statusForErrorCode(code), {
      ok: false,
      error: response.error?.message ?? `${method} failed`,
      ...(code ? { code } : {}),
    });
    return { ok: false, sent: true };
  }
  return { ok: true, payload: (response.payload ?? {}) as Record<string, unknown> };
}

/** `?id=` (preferred) or the legacy `?jobId=` alias, trimmed. */
function readJobId(url: URL): string {
  return (url.searchParams.get("id") ?? url.searchParams.get("jobId") ?? "").trim();
}

function readLimit(url: URL, fallback: number): number {
  const raw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(raw, MAX_PAGE_LIMIT);
}

// ── POST body → cron.add params ──────────────────────────────────────────────

/** Optional positive number field, or undefined when absent/invalid. */
function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The `agentTurn` payload this route is willing to create/patch. Deliberately narrow —
 * see the file header on why no caller-supplied `payload` is ever forwarded.
 */
function buildAgentTurnPayload(
  body: Record<string, unknown>,
  message: string | undefined,
): Record<string, unknown> {
  const model = nonEmptyString(body.model);
  const thinking = nonEmptyString(body.thinking);
  const timeoutSeconds = positiveNumber(body.timeoutSeconds);
  return {
    kind: "agentTurn",
    ...(message === undefined ? {} : { message }),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

/**
 * The app sends the schedule already in protocol shape (`{kind:"at"|"every"|"cron", …}`)
 * because building it is a UI concern (preset + picker + the device's own timezone).
 * We only check that it looks like an object with a supported kind and let `cron.add`'s
 * own schema validation own the rest — duplicating it here would just drift.
 */
const SUPPORTED_SCHEDULE_KINDS = new Set(["at", "every", "cron"]);

function readSchedule(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !SUPPORTED_SCHEDULE_KINDS.has(kind)) return undefined;
  return value as Record<string, unknown>;
}

// ── PATCH body → delivery patch ──────────────────────────────────────────────

const SUPPORTED_DELIVERY_MODES = new Set(["announce", "none"]);

/**
 * The restricted `delivery` patch the app may send on PATCH. Core's `cron.update` would
 * accept a free-form `CronDeliveryPatch` (including `mode:"webhook"`), but the app only
 * ever needs "announce to a channel I name" or "stop delivering" — anything else is a
 * 400 rather than a silent passthrough (same posture as the payload whitelist). Announce
 * must always carry a non-empty `channel`. `to` has three spellings: a non-empty string
 * pins the target; an EXPLICIT `null` clears any stored target so the channel's default
 * applies (core's `mergeCronDelivery` only deletes a field when the key is present with
 * a null value — omitting `to` would keep the previous channel's chat id, so omission
 * is rejected as ambiguous); and `null` is refused for friday-next itself, because a
 * targetless friday-next announce falls back to the sole-connected / last-seen device,
 * which breaks inbox attribution (see createJob). A wrong `to` (unknown device id /
 * chat id) is not validated here — the run's deliveryError surfaces it, same as any
 * channel-side failure.
 */
function readDeliveryPatch(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const mode = nonEmptyString(raw.mode);
  if (!mode || !SUPPORTED_DELIVERY_MODES.has(mode)) return undefined;
  if (mode === "none") return { mode: "none" };
  const channel = nonEmptyString(raw.channel);
  if (!channel) return undefined;
  if (raw.to === null) {
    // Explicit clear → the channel default target. Meaningless (and harmful) for
    // friday-next — see the header comment.
    if (channel === FRIDAY_NEXT_CHANNEL_ID) return undefined;
    return { mode: "announce", channel, to: null };
  }
  const to = nonEmptyString(raw.to);
  if (!to) return undefined;
  return { mode: "announce", channel, to };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/** `/friday-next-admin/cron/jobs` — list / create / update / remove. */
export async function handleCronJobs(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (attestRejects(req, "/friday-next-admin/cron/jobs")) {
    return json(res, 403, { ...ATTEST_REJECTION_BODY });
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  switch (req.method) {
    case "GET":
      return await listJobs(res, url);
    case "POST":
      return await createJob(req, res);
    case "PATCH":
      return await updateJob(req, res, url);
    case "DELETE":
      return await removeJob(res, url);
    default:
      return json(res, 405, { error: "Method Not Allowed" });
  }
}

async function listJobs(res: ServerResponse, url: URL): Promise<boolean> {
  const agentId = nonEmptyString(url.searchParams.get("agentId"));
  const outcome = await dispatchCron(res, "cron.list", {
    // Disabled jobs are exactly what the app needs to show (with their switch off) —
    // omitting them would make a paused job look deleted.
    includeDisabled: true,
    limit: readLimit(url, MAX_PAGE_LIMIT),
    ...(agentId ? { agentId: normalizeAgentId(agentId) } : {}),
  });
  if (!outcome.ok) return true;
  const { payload } = outcome;
  return json(res, 200, {
    ok: true,
    jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
    ...(typeof payload.total === "number" ? { total: payload.total } : {}),
  });
}

async function createJob(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJsonBody(req);
  if (!body) return json(res, 400, { error: "Invalid or missing JSON body" });

  const name = nonEmptyString(body.name);
  if (!name) return json(res, 400, { error: "Missing required field: name" });
  const message = nonEmptyString(body.message);
  if (!message) return json(res, 400, { error: "Missing required field: message" });
  const schedule = readSchedule(body.schedule);
  if (!schedule) {
    return json(res, 400, { error: "Missing or unsupported field: schedule" });
  }
  // Required: without it the announce falls back to the channel's sole-connected /
  // last-seen device, which is ambiguous on a multi-device account and makes inbox
  // attribution guess. The app always knows its own id.
  const deviceId = nonEmptyString(body.deviceId);
  if (!deviceId) return json(res, 400, { error: "Missing required field: deviceId" });

  const params: Record<string, unknown> = {
    name,
    ...(nonEmptyString(body.agentId) ? { agentId: normalizeAgentId(body.agentId) } : {}),
    schedule,
    // Isolated: the run gets its own throwaway session, so a scheduled turn never lands
    // in (or inherits the context of) a chat the user is reading. `main` would be worse
    // still — the app hides the main session, so that output would have no home in the UI.
    sessionTarget: "isolated",
    // Required by the schema. Meaningless for isolated runs (nothing is waiting on a
    // heartbeat to wake), so pick the one that never defers.
    wakeMode: "now",
    payload: buildAgentTurnPayload(body, message),
    delivery: { mode: "announce", channel: FRIDAY_NEXT_CHANNEL_ID, to: deviceId },
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(typeof body.deleteAfterRun === "boolean" ? { deleteAfterRun: body.deleteAfterRun } : {}),
  };

  const outcome = await dispatchCron(res, "cron.add", params);
  if (!outcome.ok) return true;
  // `cron.add` answers with the job itself, or `{created, updated?, job}` when the
  // request carried a declarationKey (we never send one, but stay tolerant).
  const { payload } = outcome;
  return json(res, 200, { ok: true, job: "job" in payload ? payload.job : payload });
}

async function updateJob(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const id = readJobId(url);
  if (!id) return json(res, 400, { error: "Missing required query param: id" });
  const body = await readJsonBody(req);
  if (!body) return json(res, 400, { error: "Invalid or missing JSON body" });

  // Whitelist, not passthrough — see the file header. Note `message`/`model`/`thinking`/
  // `timeoutSeconds` are lifted into an agentTurn payload patch, so a `command` job can
  // never be retargeted from here either.
  const patch: Record<string, unknown> = {};
  const name = nonEmptyString(body.name);
  if (name) patch.name = name;
  // Retargeting the owning agent is allowed (the app surfaces it as an explicit picker row);
  // `cron.update` accepts it for unscoped operator callers, which this route is.
  const agentId = nonEmptyString(body.agentId);
  if (agentId) patch.agentId = normalizeAgentId(agentId);
  const schedule = readSchedule(body.schedule);
  if (schedule) patch.schedule = schedule;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.deleteAfterRun === "boolean") patch.deleteAfterRun = body.deleteAfterRun;
  const touchesPayload =
    "message" in body || "model" in body || "thinking" in body || "timeoutSeconds" in body;
  if (touchesPayload) {
    patch.payload = buildAgentTurnPayload(body, nonEmptyString(body.message));
  }
  // Delivery: the app sends an explicit restricted patch ("announce to channel X" /
  // "stop delivering"); the legacy `deviceId` shorthand re-pins the job to that device.
  // Mutually exclusive — a body carrying both is ambiguous, refuse rather than guess.
  const wantsDelivery = "delivery" in body;
  const deviceId = nonEmptyString(body.deviceId);
  if (wantsDelivery && deviceId) {
    return json(res, 400, { error: "Pass either delivery or deviceId, not both" });
  }
  if (wantsDelivery) {
    const delivery = readDeliveryPatch(body.delivery);
    if (!delivery) {
      return json(res, 400, {
        error:
          'Invalid delivery: mode must be "announce" (non-empty channel; `to` a non-empty string or explicit null for the channel default) or "none"',
      });
    }
    patch.delivery = delivery;
  } else if (deviceId) {
    // Re-pin delivery when the caller names its device (e.g. the job was created on another
    // phone and this one is taking it over).
    patch.delivery = { mode: "announce", channel: FRIDAY_NEXT_CHANNEL_ID, to: deviceId };
  }

  if (Object.keys(patch).length === 0) {
    return json(res, 400, { error: "No updatable fields in body" });
  }
  const outcome = await dispatchCron(res, "cron.update", { id, patch });
  if (!outcome.ok) return true;
  const { payload } = outcome;
  return json(res, 200, { ok: true, job: "job" in payload ? payload.job : payload });
}

async function removeJob(res: ServerResponse, url: URL): Promise<boolean> {
  const id = readJobId(url);
  if (!id) return json(res, 400, { error: "Missing required query param: id" });
  const outcome = await dispatchCron(res, "cron.remove", { id });
  if (!outcome.ok) return true;
  // `cron.remove` reports a missing job as `{ok:true, removed:false}` rather than an
  // error — surfacing that as a 200 would let the app think it deleted something.
  if (outcome.payload.removed !== true) {
    return json(res, 404, { ok: false, error: `cron job not found: ${id}` });
  }
  createFridayNextLogger("cron").info(`removed scheduled task ${id}`);
  return json(res, 200, { ok: true, id, removed: true });
}

/** `/friday-next-admin/cron/jobs/run` — run one job now. */
export async function handleCronJobRun(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") return json(res, 405, { error: "Method Not Allowed" });
  if (attestRejects(req, "/friday-next-admin/cron/jobs/run")) {
    return json(res, 403, { ...ATTEST_REJECTION_BODY });
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const body = (await readJsonBody(req)) ?? {};
  const id = nonEmptyString(body.id) ?? readJobId(url);
  if (!id) return json(res, 400, { error: "Missing required field: id" });
  // `force` = run regardless of whether it is due; `cron.run` only ENQUEUES the run
  // (`enqueueRun`), so this returns immediately instead of holding the request open for
  // the whole agent turn.
  const outcome = await dispatchCron(res, "cron.run", { id, mode: "force" });
  if (!outcome.ok) return true;
  const { payload } = outcome;
  // Shapes (src/cron/service/state.ts CronRunResult): `{ok:true, enqueued:true, runId}`,
  // `{ok:true, ran:true}`, `{ok:true, ran:false, reason:"already-running"|…}`, `{ok:false}`.
  // A refusal is not an error — the app shows the reason ("already running") instead.
  if (payload.ok === false) {
    return json(res, 500, { ok: false, error: "cron.run failed" });
  }
  return json(res, 200, {
    ok: true,
    id,
    ran: payload.ran !== false,
    ...(payload.enqueued === true ? { enqueued: true } : {}),
    ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
  });
}

/** `/friday-next-admin/cron/runs` — run history for one job. */
export async function handleCronRuns(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
  if (attestRejects(req, "/friday-next-admin/cron/runs")) {
    return json(res, 403, { ...ATTEST_REJECTION_BODY });
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const jobId = readJobId(url);
  if (!jobId) return json(res, 400, { error: "Missing required query param: jobId" });
  const outcome = await dispatchCron(res, "cron.runs", {
    scope: "job",
    jobId,
    limit: readLimit(url, 20),
    sortDir: "desc",
  });
  if (!outcome.ok) return true;
  // The run-log page calls them `entries` (src/cron/run-log.ts CronRunLogPageResult);
  // the app-facing name is `runs`.
  const entries = outcome.payload.entries;
  return json(res, 200, { ok: true, jobId, runs: Array.isArray(entries) ? entries : [] });
}

/** `/friday-next-admin/cron/channels` — deliverable channel list for the delivery picker. */
export async function handleCronChannels(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });
  if (attestRejects(req, "/friday-next-admin/cron/channels")) {
    return json(res, 403, { ...ATTEST_REJECTION_BODY });
  }
  // `channels.status` (probe left off — config/runtime state only, no network probing)
  // is the same source the CLI and Control UI use, so the picker can never offer a
  // channel cron would reject as unconfigured.
  const outcome = await dispatchCron(res, "channels.status", {});
  if (!outcome.ok) return true;
  return json(res, 200, { ok: true, channels: reduceDeliveryChannels(outcome.payload) });
}

/**
 * The internal webchat channel is not a cron announce target (core refuses it with
 * "Delivering to WebChat is not supported"), so it never belongs in the picker.
 */
const NON_DELIVERABLE_CHANNELS = new Set(["webchat"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * `channels.status` payload → `[{id, label}]`, keeping only channels with a configured
 * account (an unconfigured one would fail the run with channel_not_found). friday-next
 * is pinned first: it is THIS plugin — the one entry the picker must never lose, even if
 * a partial status payload dropped its summary.
 */
function reduceDeliveryChannels(
  payload: Record<string, unknown>,
): Array<{ id: string; label: string }> {
  const order = Array.isArray(payload.channelOrder)
    ? payload.channelOrder.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  const labels = isRecord(payload.channelLabels) ? payload.channelLabels : {};
  const summaries = isRecord(payload.channels) ? payload.channels : {};
  const accounts = isRecord(payload.channelAccounts) ? payload.channelAccounts : {};

  const isConfigured = (id: string): boolean => {
    const summary = summaries[id];
    if (isRecord(summary) && summary.configured === true) return true;
    const list = accounts[id];
    return Array.isArray(list) && list.some((a) => isRecord(a) && a.configured === true);
  };

  const ids = order.filter((id) => !NON_DELIVERABLE_CHANNELS.has(id) && isConfigured(id));
  const ordered = [FRIDAY_NEXT_CHANNEL_ID, ...ids.filter((id) => id !== FRIDAY_NEXT_CHANNEL_ID)];
  return ordered.map((id) => {
    const label = labels[id];
    return { id, label: typeof label === "string" && label.trim() ? label : id };
  });
}
