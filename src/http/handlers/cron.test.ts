// Tests for /friday-next-admin/cron/* — scheduled-task management via the canonical
// gateway `cron.*` methods. The load-bearing assertions are the SHAPE of the params this
// route assembles (isolated / agentTurn / friday-next announce) and the refusal payloads
// cron answers with `ok: true` (`removed: false`, `ran: false`).
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCronJobs, handleCronJobRun, handleCronRuns } from "./cron.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;
type Captured = { statusCode: number; headers: Record<string, unknown>; body: string };
type Handler = (req: IncomingMessageLike, res: ServerResponseLike) => Promise<boolean>;

function makeReq(method: string, url: string, body?: unknown): IncomingMessageLike {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf-8")];
  const req = Readable.from(chunks) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

function makeRes(): { res: ServerResponseLike; captured: Captured } {
  const captured: Captured = { statusCode: 200, headers: {}, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(v: number) {
      captured.statusCode = v;
    },
    setHeader(name: string, value: unknown) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  return { res, captured };
}

async function invoke(handler: Handler, method: string, url: string, body?: unknown) {
  const { res, captured } = makeRes();
  const handled = await handler(makeReq(method, url, body), res);
  return {
    handled,
    captured,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

/** The minimum body `POST /cron/jobs` accepts. */
const CREATE_BODY = {
  deviceId: "DEVICE-1",
  name: "早报",
  message: "播报今天的天气和日程",
  schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
};

beforeEach(() => {
  dispatchGatewayMethod.mockReset();
});

describe("handleCronJobs — list", () => {
  it("dispatches cron.list including disabled jobs and returns them", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: { jobs: [{ id: "j1", name: "早报" }], total: 1 },
    });

    const { captured, json } = await invoke(handleCronJobs, "GET", "/friday-next-admin/cron/jobs");

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.list", {
      includeDisabled: true,
      limit: 200,
    });
    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: true, total: 1, jobs: [{ id: "j1" }] });
  });

  it("normalizes and forwards an explicit agentId filter", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { jobs: [] } });
    await invoke(handleCronJobs, "GET", "/friday-next-admin/cron/jobs?agentId=Miloco&limit=5");
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.list", {
      includeDisabled: true,
      limit: 5,
      agentId: "miloco",
    });
  });

  it("clamps limit to the protocol's 200 ceiling", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { jobs: [] } });
    await invoke(handleCronJobs, "GET", "/friday-next-admin/cron/jobs?limit=9999");
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.list", {
      includeDisabled: true,
      limit: 200,
    });
  });

  it("returns 405 for unsupported methods", async () => {
    const { captured } = await invoke(handleCronJobs, "PUT", "/friday-next-admin/cron/jobs");
    expect(captured.statusCode).toBe(405);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});

describe("handleCronJobs — create", () => {
  it("assembles an isolated agentTurn job announcing to this device", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { id: "j1", name: "早报" } });

    const { captured, json } = await invoke(
      handleCronJobs,
      "POST",
      "/friday-next-admin/cron/jobs",
      CREATE_BODY,
    );

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.add", {
      name: "早报",
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "播报今天的天气和日程" },
      delivery: { mode: "announce", channel: "friday-next", to: "DEVICE-1" },
    });
    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: true, job: { id: "j1" } });
  });

  it("unwraps the declaration-key result shape", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: { created: true, job: { id: "j2" } },
    });
    const { json } = await invoke(
      handleCronJobs,
      "POST",
      "/friday-next-admin/cron/jobs",
      CREATE_BODY,
    );
    expect(json).toMatchObject({ ok: true, job: { id: "j2" } });
  });

  it("forwards optional agent, model and timeout overrides", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { id: "j1" } });
    await invoke(handleCronJobs, "POST", "/friday-next-admin/cron/jobs", {
      ...CREATE_BODY,
      agentId: "Miloco",
      model: "anthropic/claude-opus-5",
      thinking: "low",
      timeoutSeconds: 600,
      enabled: false,
      deleteAfterRun: true,
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({
        agentId: "miloco",
        enabled: false,
        deleteAfterRun: true,
        payload: {
          kind: "agentTurn",
          message: "播报今天的天气和日程",
          model: "anthropic/claude-opus-5",
          thinking: "low",
          timeoutSeconds: 600,
        },
      }),
    );
  });

  it("never forwards a caller-supplied command payload", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { id: "j1" } });
    await invoke(handleCronJobs, "POST", "/friday-next-admin/cron/jobs", {
      ...CREATE_BODY,
      payload: { kind: "command", argv: ["sh", "-lc", "rm -rf /"] },
      sessionTarget: "main",
    });
    const params = dispatchGatewayMethod.mock.calls[0][1] as Record<string, unknown>;
    expect(params.payload).toEqual({ kind: "agentTurn", message: "播报今天的天气和日程" });
    expect(params.sessionTarget).toBe("isolated");
  });

  it.each([
    ["name", { ...CREATE_BODY, name: "  " }],
    ["message", { ...CREATE_BODY, message: "" }],
    ["deviceId", { ...CREATE_BODY, deviceId: undefined }],
    ["schedule", { ...CREATE_BODY, schedule: { kind: "on-exit", command: "sleep 1" } }],
  ])("returns 400 without dispatching when %s is missing or unsupported", async (_field, body) => {
    const { captured } = await invoke(handleCronJobs, "POST", "/friday-next-admin/cron/jobs", body);
    expect(captured.statusCode).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("maps an INVALID_REQUEST gateway error to 400", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "invalid cron.add params: bad expr" },
    });
    const { captured, json } = await invoke(
      handleCronJobs,
      "POST",
      "/friday-next-admin/cron/jobs",
      CREATE_BODY,
    );
    expect(captured.statusCode).toBe(400);
    expect(json).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("returns 500 when dispatch throws", async () => {
    dispatchGatewayMethod.mockRejectedValue(new Error("dispatch reserved for contracts"));
    const { captured, json } = await invoke(
      handleCronJobs,
      "POST",
      "/friday-next-admin/cron/jobs",
      CREATE_BODY,
    );
    expect(captured.statusCode).toBe(500);
    expect(json).toMatchObject({ ok: false });
  });
});

describe("handleCronJobs — update", () => {
  it("sends only whitelisted fields as a patch", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { id: "j1" } });
    await invoke(handleCronJobs, "PATCH", "/friday-next-admin/cron/jobs?id=j1", {
      enabled: false,
      name: "晚报",
      owner: { agentId: "other" },
      sessionTarget: "main",
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.update", {
      id: "j1",
      patch: { name: "晚报", enabled: false },
    });
  });

  it("retargets the owning agent when asked", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { id: "j1" } });
    await invoke(handleCronJobs, "PATCH", "/friday-next-admin/cron/jobs?id=j1", {
      agentId: "Miloco",
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.update", {
      id: "j1",
      patch: { agentId: "miloco" },
    });
  });

  it("lifts message/model edits into an agentTurn payload patch", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { id: "j1" } });
    await invoke(handleCronJobs, "PATCH", "/friday-next-admin/cron/jobs?id=j1", {
      message: "换个说法",
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.update", {
      id: "j1",
      patch: { payload: { kind: "agentTurn", message: "换个说法" } },
    });
  });

  it("re-pins delivery when the caller names its device", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { id: "j1" } });
    await invoke(handleCronJobs, "PATCH", "/friday-next-admin/cron/jobs?id=j1", {
      deviceId: "DEVICE-2",
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.update", {
      id: "j1",
      patch: { delivery: { mode: "announce", channel: "friday-next", to: "DEVICE-2" } },
    });
  });

  it("forwards a stop-delivering delivery patch as-is", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { id: "j1" } });
    await invoke(handleCronJobs, "PATCH", "/friday-next-admin/cron/jobs?id=j1", {
      delivery: { mode: "none" },
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.update", {
      id: "j1",
      patch: { delivery: { mode: "none" } },
    });
  });

  it("forwards an announce-to-another-channel delivery patch as-is", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { id: "j1" } });
    await invoke(handleCronJobs, "PATCH", "/friday-next-admin/cron/jobs?id=j1", {
      delivery: { mode: "announce", channel: "telegram", to: "-1001234" },
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.update", {
      id: "j1",
      patch: { delivery: { mode: "announce", channel: "telegram", to: "-1001234" } },
    });
  });

  it.each([
    ["webhook mode", { mode: "webhook", to: "https://example.com/hook" }],
    ["unknown mode", { mode: "deliver" }],
    ["announce without channel", { mode: "announce", to: "-1001234" }],
    ["announce without to", { mode: "announce", channel: "telegram" }],
    ["not an object", "none"],
  ])("rejects an invalid delivery patch (%s) with a 400", async (_label, delivery) => {
    const { captured } = await invoke(handleCronJobs, "PATCH", "/friday-next-admin/cron/jobs?id=j1", {
      delivery,
    });
    expect(captured.statusCode).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("refuses a body carrying both delivery and deviceId", async () => {
    const { captured } = await invoke(handleCronJobs, "PATCH", "/friday-next-admin/cron/jobs?id=j1", {
      deviceId: "DEVICE-2",
      delivery: { mode: "none" },
    });
    expect(captured.statusCode).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("returns 400 without dispatching when id is missing", async () => {
    const { captured } = await invoke(handleCronJobs, "PATCH", "/friday-next-admin/cron/jobs", {
      enabled: false,
    });
    expect(captured.statusCode).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("returns 400 without dispatching when nothing updatable was sent", async () => {
    const { captured } = await invoke(
      handleCronJobs,
      "PATCH",
      "/friday-next-admin/cron/jobs?id=j1",
      {
        owner: { agentId: "x" },
      },
    );
    expect(captured.statusCode).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});

describe("handleCronJobs — remove", () => {
  it("dispatches cron.remove and reports the deletion", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { ok: true, removed: true } });
    const { captured, json } = await invoke(
      handleCronJobs,
      "DELETE",
      "/friday-next-admin/cron/jobs?id=j1",
    );
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.remove", { id: "j1" });
    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: true, id: "j1", removed: true });
  });

  it("turns cron's `removed: false` refusal into a 404", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { ok: true, removed: false } });
    const { captured, json } = await invoke(
      handleCronJobs,
      "DELETE",
      "/friday-next-admin/cron/jobs?id=ghost",
    );
    expect(captured.statusCode).toBe(404);
    expect(json).toMatchObject({ ok: false });
  });

  it("accepts the legacy jobId alias", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { ok: true, removed: true } });
    await invoke(handleCronJobs, "DELETE", "/friday-next-admin/cron/jobs?jobId=j1");
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.remove", { id: "j1" });
  });
});

describe("handleCronJobRun", () => {
  it("force-runs the job and surfaces the enqueued run id", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: { ok: true, enqueued: true, runId: "r1" },
    });
    const { captured, json } = await invoke(
      handleCronJobRun,
      "POST",
      "/friday-next-admin/cron/jobs/run",
      { id: "j1" },
    );
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.run", { id: "j1", mode: "force" });
    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: true, id: "j1", ran: true, enqueued: true, runId: "r1" });
  });

  it("passes a refusal reason through as a 200", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: { ok: true, ran: false, reason: "already-running" },
    });
    const { captured, json } = await invoke(
      handleCronJobRun,
      "POST",
      "/friday-next-admin/cron/jobs/run",
      { id: "j1" },
    );
    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: true, ran: false, reason: "already-running" });
  });

  it("reports a hard `ok: false` run result as a 500", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { ok: false } });
    const { captured, json } = await invoke(
      handleCronJobRun,
      "POST",
      "/friday-next-admin/cron/jobs/run",
      { id: "j1" },
    );
    expect(captured.statusCode).toBe(500);
    expect(json).toMatchObject({ ok: false });
  });

  it("returns 405 for non-POST and 400 without an id", async () => {
    const wrongMethod = await invoke(handleCronJobRun, "GET", "/friday-next-admin/cron/jobs/run");
    expect(wrongMethod.captured.statusCode).toBe(405);
    const noId = await invoke(handleCronJobRun, "POST", "/friday-next-admin/cron/jobs/run", {});
    expect(noId.captured.statusCode).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});

describe("handleCronRuns", () => {
  it("returns the run-log page's `entries` as `runs`", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: true,
      payload: { entries: [{ runId: "r1", status: "ok" }], total: 1 },
    });
    const { captured, json } = await invoke(
      handleCronRuns,
      "GET",
      "/friday-next-admin/cron/runs?jobId=j1",
    );
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("cron.runs", {
      scope: "job",
      jobId: "j1",
      limit: 20,
      sortDir: "desc",
    });
    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: true, jobId: "j1", runs: [{ runId: "r1" }] });
  });

  it("returns 400 without dispatching when jobId is missing", async () => {
    const { captured } = await invoke(handleCronRuns, "GET", "/friday-next-admin/cron/runs");
    expect(captured.statusCode).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});
