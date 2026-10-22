import type { IncomingMessage, ServerResponse } from "node:http";
import { getOpenClawChannelService } from "../adapters/openclaw/channel-service.js";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";
import { sseEmitter } from "../sse/emitter.js";
import { handleAdminToolCatalog } from "./handlers/admin-tool-catalog.js";
import { handleAgentIdentity } from "./handlers/agent-identity.js";
import { handleCommandsList } from "./handlers/commands-list.js";
import {
  handleCronChannels,
  handleCronJobRun,
  handleCronJobs,
  handleCronRuns,
} from "./handlers/cron.js";
import { handleInbox } from "./handlers/inbox.js";
import { handleAdminModelsList } from "./handlers/models-list.js";
import { handleSessionDelete } from "./handlers/session-delete.js";
import { handleSessionFork, handleSessionRewind } from "./handlers/session-message-actions.js";
import { handleSessionReadState } from "./handlers/session-read-state.js";
import { handleTalk } from "./handlers/talk.js";
import { handleTts } from "./handlers/tts.js";

type ProductHTTPHandler = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
function serviceIdentityGuard(
  handler: ProductHTTPHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => await getOpenClawChannelService().withIdentity(handler)(req, res);
}

export function registerFridayNextHttpRoutes(api: {
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  registerHttpRoute: (route: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
    auth: string;
    match: string;
    /** Operator-scope surface for `auth: "gateway"` routes (e.g. "trusted-operator"). */
    gatewayRuntimeScopeSurface?: string;
  }) => void;
}): void {
  const cfg = resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
  sseEmitter.setBacklogLimit(cfg.sseBacklogPerDevice);
  if (!cfg.authToken) {
    api.logger.warn("friday-next authToken not configured; all requests will 401");
  }

  // Plugin handles its own auth via extractBearerToken()
  api.registerHttpRoute({
    path: "/friday-next",
    handler: (req, res) => getOpenClawChannelService().handle(req, res),
    auth: "plugin",
    match: "prefix",
  });

  // Permanent server-side session deletion. Registered under a SIBLING prefix
  // (`/friday-next-admin`, not `/friday-next`) because a gateway-authed route
  // cannot overlap the `/friday-next` `auth: "plugin"` prefix (core rejects
  // overlapping routes with mismatched auth). `auth: "gateway"` +
  // "trusted-operator" grants the `operator.admin` scope that `sessions.delete`
  // requires; the shared-secret bearer the app already sends satisfies it.
  api.registerHttpRoute({
    path: "/friday-next-admin/sessions",
    handler: serviceIdentityGuard(handleSessionDelete),
    auth: "gateway",
    match: "exact",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });

  // OpenClaw 原生会话未读状态。读取走 sessions.list，写入走 sessions.patch；
  // 两者都必须运行在 Gateway 鉴权请求作用域，不能从普通插件鉴权路由代调。
  // 不提升到 trusted-operator：这里的受限 patch 字段仅需 operator.write。
  // 回退需要 admin；分叉只需 write，分别注册避免扩大分叉的权限面。
  api.registerHttpRoute({
    path: "/friday-next-admin/sessions/rewind",
    handler: serviceIdentityGuard(handleSessionRewind),
    auth: "gateway",
    match: "exact",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });
  api.registerHttpRoute({
    path: "/friday-next-admin/sessions/fork",
    handler: serviceIdentityGuard(handleSessionFork),
    auth: "gateway",
    match: "exact",
  });
  api.registerHttpRoute({
    path: "/friday-next-admin/sessions/state",
    handler: serviceIdentityGuard(handleSessionReadState),
    auth: "gateway",
    match: "exact",
  });

  // Agent rename. Same sibling-prefix + trusted-operator reasoning as above:
  // the canonical `agents.update` method requires `operator.admin`.
  api.registerHttpRoute({
    path: "/friday-next-admin/agents/identity",
    handler: serviceIdentityGuard(handleAgentIdentity),
    auth: "gateway",
    match: "exact",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });

  // Slash-command catalog for the composer menu. Same sibling-prefix reasoning
  // (plugin-authed routes get an empty operator scope list, so they can't
  // dispatch scoped methods), but NO "trusted-operator": `commands.list` only
  // needs `operator.read`, which the default surface's `operator.write` already
  // satisfies. Least privilege for a read-only listing.
  api.registerHttpRoute({
    path: "/friday-next-admin/commands",
    handler: serviceIdentityGuard(handleCommandsList),
    auth: "gateway",
    match: "exact",
  });

  // Model catalog for the composer/agent model pickers. Same sibling-prefix +
  // least-privilege reasoning as `/friday-next-admin/commands`: `models.list`
  // (the same method Control UI's chat page calls) only needs `operator.read`.
  api.registerHttpRoute({
    path: "/friday-next-admin/models",
    handler: serviceIdentityGuard(handleAdminModelsList),
    auth: "gateway",
    match: "exact",
  });

  // Agent tool catalog for the toolbox editor. Same sibling-prefix + least-privilege
  // reasoning as `/friday-next-admin/commands`: `tools.catalog` only needs
  // `operator.read`, satisfied by the default surface's `operator.write`. Replaces the
  // legacy plugin-authed deep-import path, which executed a captured core dist chunk
  // needing `jiti` and broke on 2026.9.5+.
  api.registerHttpRoute({
    path: "/friday-next-admin/tool-catalog",
    handler: serviceIdentityGuard(handleAdminToolCatalog),
    auth: "gateway",
    match: "exact",
  });

  // Inbox v2 聚合三类原生审批以及 Control UI 同源的 cron/model/update 当前状态。
  // 读取 approvals 需要 operator.approvals，update.status 需要 operator.admin，因此使用
  // trusted-operator；处理器仍只开放快照、严格审批转发和 cron 历史删除三个窄操作。
  api.registerHttpRoute({
    path: "/friday-next-admin/inbox",
    handler: serviceIdentityGuard(handleInbox),
    auth: "gateway",
    match: "prefix",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });

  // Scheduled-task (cron) management. Same sibling-prefix reasoning as above. The two
  // mutating routes need "trusted-operator" because `cron.add` / `cron.update` /
  // `cron.remove` / `cron.run` all require `operator.admin`; the run-history route does
  // NOT, since `cron.runs` only needs `operator.read` (least privilege, same call
  // commands-list makes). See handlers/cron.ts for why the app can only ever create
  // `agentTurn` jobs through this surface.
  api.registerHttpRoute({
    path: "/friday-next-admin/cron/jobs",
    handler: serviceIdentityGuard(handleCronJobs),
    auth: "gateway",
    match: "exact",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });
  api.registerHttpRoute({
    path: "/friday-next-admin/cron/jobs/run",
    handler: serviceIdentityGuard(handleCronJobRun),
    auth: "gateway",
    match: "exact",
    gatewayRuntimeScopeSurface: "trusted-operator",
  });
  api.registerHttpRoute({
    path: "/friday-next-admin/cron/runs",
    handler: serviceIdentityGuard(handleCronRuns),
    auth: "gateway",
    match: "exact",
  });
  // Delivery-target channel list for the cron editor's picker. Read-only like
  // `/cron/runs`: `channels.status` only needs `operator.read`, so no
  // "trusted-operator" surface here either.
  api.registerHttpRoute({
    path: "/friday-next-admin/cron/channels",
    handler: serviceIdentityGuard(handleCronChannels),
    auth: "gateway",
    match: "exact",
  });

  // 消息朗读只使用核心 TTS 配置，保持默认 operator 权限。
  api.registerHttpRoute({
    path: "/friday-next-admin/tts",
    handler: serviceIdentityGuard(handleTts),
    auth: "gateway",
    match: "prefix",
  });
  // Native Talk (catalog / config / speak / mode) plus realtime session
  // (create / audio / cancel / close). Never request includeSecrets — credentials stay on Gateway.
  api.registerHttpRoute({
    path: "/friday-next-admin/talk",
    handler: serviceIdentityGuard(handleTalk),
    auth: "gateway",
    match: "prefix",
    // COMPAT(openclaw<=2026.7.1 talk-managed-room-scope): that host requires operator.admin when
    // `talk.session.create` joins a managed room by sessionKey. Current hosts only document
    // operator.write, but the handler's strict method/field allowlist keeps this broader legacy
    // surface bounded to Talk operations.
    // CLEANUP: remove trusted-operator after minHostVersion > 2026.7.1 and a live managed-room
    // create/close test passes with the default operator.write surface.
    gatewayRuntimeScopeSurface: "trusted-operator",
  });

  api.logger.info("Friday Next channel HTTP routes registered at /friday-next/*");
}
