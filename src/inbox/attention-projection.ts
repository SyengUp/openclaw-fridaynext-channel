export type InboxCategory = "approvals" | "automations" | "system";
export type InboxAttentionKind =
  | "execApproval"
  | "pluginApproval"
  | "systemAgentApproval"
  | "cronFailed"
  | "cronOverdue"
  | "modelAuthExpired"
  | "scopeUpgrade"
  | "update";

export interface InboxAttentionItem {
  id: string;
  category: InboxCategory;
  kind: InboxAttentionKind;
  lifecycle: "attention";
  signature: string;
  requiresAction: boolean;
  severity: "error" | "warning" | "neutral";
  title: string;
  detail?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
  agentId?: string;
  payload?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function opaqueId(value: unknown): string | undefined {
  // 审批 id 是 gateway 铸造的不透明值，不得 trim，否则可能把两个不同审批折叠为一个。
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function approvalRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = record(value);
  for (const key of ["approvals", "pending", "items"]) {
    if (Array.isArray(object?.[key])) return object[key];
  }
  return [];
}

export function projectApprovals(
  sources: Partial<Record<"exec" | "plugin" | "system-agent", unknown>>,
  nowMs = Date.now(),
): InboxAttentionItem[] {
  const result: InboxAttentionItem[] = [];
  for (const kind of ["exec", "plugin", "system-agent"] as const) {
    for (const raw of approvalRows(sources[kind])) {
      const item = record(raw);
      const request = record(item?.request);
      const id = opaqueId(item?.id);
      const createdAtMs = finiteNumber(item?.createdAtMs);
      const expiresAtMs = finiteNumber(item?.expiresAtMs);
      if (!item || !request || !id || !createdAtMs || !expiresAtMs || expiresAtMs <= nowMs)
        continue;

      let title: string | undefined;
      let detail: string | undefined;
      if (kind === "exec") {
        title = stringValue(request.command);
        detail = stringValue(request.cwd) ?? stringValue(request.host);
      } else {
        title = stringValue(request.title);
        detail = stringValue(request.description);
      }
      if (!title) continue;
      if (
        kind === "system-agent" &&
        (!detail || !stringValue(request.command) || !stringValue(request.proposalHash))
      ) {
        continue;
      }
      const normalizedRequest =
        kind === "system-agent"
          ? { ...request, allowedDecisions: ["allow-once", "deny"] }
          : request;
      result.push({
        id: `approval:${kind}:${id}`,
        category: "approvals",
        kind:
          kind === "exec"
            ? "execApproval"
            : kind === "plugin"
              ? "pluginApproval"
              : "systemAgentApproval",
        lifecycle: "attention",
        signature: `${kind}:${id}`,
        requiresAction: true,
        severity: kind === "plugin" && request.severity === "error" ? "error" : "warning",
        title,
        ...(detail ? { detail } : {}),
        createdAtMs,
        expiresAtMs,
        ...(stringValue(request.agentId) ? { agentId: stringValue(request.agentId) } : {}),
        payload: { ...item, request: normalizedRequest, approvalKind: kind },
      });
    }
  }
  return result.sort(
    (left, right) =>
      (left.createdAtMs ?? 0) - (right.createdAtMs ?? 0) || left.id.localeCompare(right.id),
  );
}

export function projectAutomationAttention(params: {
  jobs: readonly unknown[];
  schedulerEnabled: boolean | null;
  nowMs?: number;
}): InboxAttentionItem[] {
  const nowMs = params.nowMs ?? Date.now();
  const failed: InboxAttentionItem[] = [];
  const overdue: InboxAttentionItem[] = [];
  for (const raw of params.jobs) {
    const job = record(raw);
    const state = record(job?.state);
    const id = stringValue(job?.id);
    if (!job || !id) continue;
    const title = stringValue(job.name) ?? id;
    const enabled = job.enabled === true;
    const lastStatus = stringValue(state?.lastRunStatus) ?? stringValue(state?.lastStatus);
    // Control UI 把 state.autoDisabled 的结构化记录本身作为升级后的失败状态；它不是布尔值。
    const autoDisabled = record(state?.autoDisabled) !== undefined;
    const lastRunAtMs = finiteNumber(state?.lastRunAtMs) ?? finiteNumber(job.updatedAtMs);
    if (autoDisabled || (enabled && lastStatus === "error")) {
      failed.push({
        id: `automation:cronFailed:${id}`,
        category: "automations",
        kind: "cronFailed",
        lifecycle: "attention",
        signature: id,
        requiresAction: true,
        severity: "error",
        title,
        detail: autoDisabled ? "任务因连续失败被自动停用" : "最近一次运行失败",
        ...(lastRunAtMs === undefined ? {} : { createdAtMs: lastRunAtMs }),
        payload: { jobId: id, autoDisabled, lastRunStatus: lastStatus ?? "unknown" },
      });
    }

    const nextRunAtMs = finiteNumber(state?.nextRunAtMs);
    const running = finiteNumber(state?.runningAtMs) !== undefined;
    if (
      params.schedulerEnabled !== false &&
      enabled &&
      !running &&
      nextRunAtMs !== undefined &&
      nowMs - nextRunAtMs > 300_000
    ) {
      overdue.push({
        id: `automation:cronOverdue:${id}:${nextRunAtMs}`,
        category: "automations",
        kind: "cronOverdue",
        lifecycle: "attention",
        signature: `${id}@${nextRunAtMs}`,
        requiresAction: true,
        severity: "warning",
        title,
        detail: "已超过计划运行时间 5 分钟",
        createdAtMs: nextRunAtMs,
        payload: { jobId: id, nextRunAtMs },
      });
    }
  }
  failed.sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0));
  overdue.sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0));
  return [...failed, ...overdue];
}

function canonicalProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "claude-cli") return "anthropic";
  if (
    normalized === "minimax-portal" ||
    normalized === "minimax-cn" ||
    normalized === "minimax-portal-cn"
  ) {
    return "minimax";
  }
  return normalized;
}

const AUTH_STATUS_PRIORITY = ["expired", "missing", "expiring", "ok", "static"];

export function projectModelAuthAttention(
  value: unknown,
  agentId: string | undefined,
  nowMs = Date.now(),
): InboxAttentionItem[] {
  const result = record(value);
  const rows = Array.isArray(result?.providers) ? result.providers : [];
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const raw of rows) {
    const provider = record(raw);
    const providerId = stringValue(provider?.provider);
    if (!provider || !providerId) continue;
    const canonical = canonicalProviderId(providerId);
    grouped.set(canonical, [...(grouped.get(canonical) ?? []), provider]);
  }
  const ts = finiteNumber(result?.ts) ?? nowMs;
  const items: InboxAttentionItem[] = [];
  for (const [providerId, providers] of grouped) {
    const selected = providers.reduce((worst, candidate) => {
      const left = AUTH_STATUS_PRIORITY.indexOf(stringValue(worst.status) ?? "static");
      const right = AUTH_STATUS_PRIORITY.indexOf(stringValue(candidate.status) ?? "static");
      return right >= 0 && (left < 0 || right < left) ? candidate : worst;
    });
    const profiles = providers.flatMap((provider) =>
      Array.isArray(provider.profiles)
        ? provider.profiles.flatMap((entry) => (record(entry) ? [record(entry)!] : []))
        : [],
    );
    const status = stringValue(selected.status);
    const monitored =
      status === "missing" ||
      profiles.some((profile) => profile.type === "oauth" || profile.type === "token");
    if (!monitored || (status !== "expired" && status !== "missing")) continue;
    const scope =
      profiles.find((profile) => profile.status === "expired" || profile.status === "missing")
        ?.profileId ?? agentId;
    const signature = agentId ? `agent:${agentId}\n${providerId}` : providerId;
    items.push({
      id: `system:modelAuthExpired:${signature}`,
      category: "system",
      kind: "modelAuthExpired",
      lifecycle: "attention",
      signature,
      requiresAction: true,
      severity: "error",
      title: stringValue(selected.displayName) ?? providerId,
      detail: status === "missing" ? "模型认证缺失" : "模型认证已过期",
      createdAtMs: ts,
      ...(agentId ? { agentId } : {}),
      payload: { provider: providerId, status, ...(scope ? { scope } : {}) },
    });
  }
  return items;
}

export function projectUpdateAttention(
  value: unknown,
  serverInstanceId: string,
  nowMs = Date.now(),
): InboxAttentionItem[] {
  const status = record(value);
  if (!status) return [];
  const activeRun = record(status.activeRun);
  const lastRun = record(status.lastRun);
  const updateAvailable = record(status.updateAvailable);
  const schedule = record(status.schedule);
  const campaign = record(schedule?.campaign);
  const sentinel = record(status.sentinel);
  const active = activeRun?.status === "running" ? activeRun : undefined;
  const finishedAtMs = finiteNumber(lastRun?.finishedAtMs);
  const recentRun =
    lastRun &&
    lastRun.status !== "running" &&
    finishedAtMs !== undefined &&
    nowMs - finishedAtMs < 24 * 60 * 60 * 1_000
      ? lastRun
      : undefined;
  const sentinelStats = record(sentinel?.stats);
  const sentinelStatus = stringValue(sentinel?.status);
  const sentinelReason = stringValue(sentinelStats?.reason);
  const sentinelFailed =
    sentinel?.kind === "update" &&
    (sentinelStatus === "error" ||
      (sentinelStatus === "skipped" &&
        sentinelReason !== "managed-service-handoff-started" &&
        sentinelReason !== "restart-health-pending" &&
        sentinelReason !== "already-current" &&
        sentinelReason !== "managed-service-handoff-already-running" &&
        sentinelReason !== "managed-service-handoff-cancelled"));
  const scheduleTarget = record(schedule?.target);
  const updateActionable = Boolean(
    campaign ||
    (updateAvailable &&
      (stringValue(updateAvailable.latestVersion) !== stringValue(updateAvailable.currentVersion) ||
        (finiteNumber(updateAvailable.commitsBehind) ?? 0) > 0)) ||
    (scheduleTarget?.kind === "git" && (finiteNumber(scheduleTarget.commitsBehind) ?? 0) > 0),
  );
  const visible = Boolean(active || recentRun || updateActionable || sentinelFailed);
  if (!visible) return [];

  const run = active ?? recentRun;
  const runId = stringValue(run?.runId);
  const runStatus = stringValue(run?.status);
  const runTarget = record(run?.target);
  const runAfter = record(run?.after);
  const runBefore = record(run?.before);
  const target = runTarget ?? scheduleTarget;
  const version =
    stringValue(target?.version) ??
    stringValue(target?.upstreamSha) ??
    stringValue(runAfter?.version) ??
    stringValue(runBefore?.version) ??
    stringValue(updateAvailable?.upstreamSha) ??
    stringValue(updateAvailable?.latestVersion);
  const signature = runId
    ? JSON.stringify(["run", runId])
    : JSON.stringify([version ?? "update", serverInstanceId]);
  const busy = Boolean(active || campaign?.state === "applying");
  const failed = runStatus === "failed" || runStatus === "rolled-back" || sentinelFailed;
  // 与 Control UI 一致：已经终止的 update run 是一份等待本机确认的报告，
  // 即使结果失败也不是强制 attention。没有对应 run 的 sentinel 故障才保持强制。
  const forced = busy || (!run && sentinelFailed);
  const reason = stringValue(run?.reason) ?? (sentinelFailed ? sentinelReason : undefined);
  const origin = record(run?.origin);
  const verification = record(run?.verification);
  const failedSteps = (Array.isArray(run?.steps) ? run.steps : []).flatMap((raw) => {
    const step = record(raw);
    if (step?.status !== "failed") return [];
    const name = stringValue(step.step);
    if (!name) return [];
    const detail = stringValue(step.detail);
    return [detail ? `${name}: ${detail}` : name];
  });
  const pluginErrors = (
    Array.isArray(verification?.pluginErrors) ? verification.pluginErrors : []
  ).flatMap((entry) => (stringValue(entry) ? [stringValue(entry)!] : []));
  const diagnostic: Record<string, unknown> = {
    ...(runId ? { runId } : {}),
    ...((runStatus ?? sentinelStatus) ? { status: runStatus ?? sentinelStatus } : {}),
    ...(stringValue(run?.phase) ? { phase: stringValue(run?.phase) } : {}),
    ...(reason ? { reason } : {}),
    ...(version ? { targetVersion: version } : {}),
    ...(failedSteps.length > 0 ? { failedSteps } : {}),
    ...(stringValue(verification?.runningVersion)
      ? { runningVersion: stringValue(verification?.runningVersion) }
      : {}),
    ...(typeof verification?.serviceRunning === "boolean"
      ? { serviceRunning: verification.serviceRunning }
      : {}),
    ...(pluginErrors.length > 0 ? { pluginErrors } : {}),
    ...(stringValue(origin?.nextAction) ? { nextAction: stringValue(origin?.nextAction) } : {}),
    ...(stringValue(origin?.doctorHint) ? { doctorHint: stringValue(origin?.doctorHint) } : {}),
    ...(finishedAtMs === undefined ? {} : { finishedAtMs }),
  };
  const detailParts = failed ? [reason ?? failedSteps[0], version] : [version];
  const detail = [...new Set(detailParts.filter((entry): entry is string => Boolean(entry)))].join(
    " · ",
  );
  const title = busy
    ? "OpenClaw 正在更新"
    : failed
      ? "OpenClaw 更新失败"
      : updateActionable
        ? "OpenClaw 有可用更新"
        : "OpenClaw 更新已完成";
  return [
    {
      id: `system:update:${signature}`,
      category: "system",
      kind: "update",
      lifecycle: "attention",
      signature,
      requiresAction: forced || updateActionable,
      severity:
        runStatus === "failed" || runStatus === "rolled-back" || sentinelStatus === "error"
          ? "error"
          : "warning",
      title,
      ...(detail ? { detail } : {}),
      ...(finiteNumber(run?.createdAtMs) === undefined
        ? {}
        : { createdAtMs: finiteNumber(run?.createdAtMs) }),
      payload: {
        busy,
        forced,
        canDismiss: !forced,
        diagnostic,
        status,
      },
    },
  ];
}
