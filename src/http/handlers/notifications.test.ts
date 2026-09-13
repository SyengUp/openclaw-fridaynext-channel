import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { setNotificationsBaseDirForTest } from "../../notifications/notifications-store.js";
import { handleNotifications } from "./notifications.js";

const { loadCronStore } = vi.hoisted(() => ({ loadCronStore: vi.fn() }));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  loadCronStore,
  resolveCronStorePath: () => "/tmp/cron.json",
}));

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;

const deviceId = "HEARTBEAT-CLEANUP-DEVICE";
let dir = "";

function makeReq(): IncomingMessageLike {
  const req = Readable.from([]) as unknown as IncomingMessageLike;
  req.method = "GET";
  req.url = `/friday-next/notifications?deviceId=${deviceId}&afterSeq=0`;
  req.headers = { authorization: "Bearer test-token" };
  return req;
}

async function invoke() {
  const captured = { statusCode: 200, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    setHeader() {},
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  await handleNotifications(makeReq(), res);
  return {
    status: captured.statusCode,
    json: JSON.parse(captured.body) as {
      notifications: Array<{ seq: number; hidden?: boolean; jobName?: string }>;
    },
  };
}

beforeEach(() => {
  setMockRuntime({ authToken: "test-token" });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-notification-route-"));
  setNotificationsBaseDirForTest(dir);
  loadCronStore.mockReset();
  loadCronStore.mockResolvedValue({
    jobs: [
      {
        id: "heartbeat-job",
        name: "heartbeat-main",
        declarationKey: "heartbeat:main",
        payload: { kind: "heartbeat" },
      },
      { id: "daily-job", name: "每日科技", payload: { kind: "agentTurn" } },
    ],
  });
  const records = [
    {
      seq: 1,
      ts: 1,
      agentId: "main",
      kind: "cron",
      sourceSessionKey: "",
      jobId: "heartbeat-job",
      text: "被错误归因给系统心跳的普通进度",
      hasMedia: false,
    },
    {
      seq: 2,
      ts: 2,
      agentId: "main",
      kind: "heartbeat",
      sourceSessionKey: "agent:main:main:heartbeat",
      text: "旧版直接心跳记录",
      hasMedia: false,
    },
    {
      seq: 3,
      ts: 3,
      agentId: "main",
      kind: "cron",
      sourceSessionKey: "",
      jobId: "daily-job",
      text: "真正的定时任务通知",
      hasMedia: false,
    },
    {
      seq: 4,
      ts: 4,
      agentId: "main",
      kind: "push",
      sourceSessionKey: "agent:main:fridaynext:device",
      text: "First heartbeat alert: your bot runs periodic background checks and messages you only when something needs attention.\n旧版心跳报告",
      hasMedia: false,
    },
  ];
  fs.writeFileSync(
    path.join(dir, `${deviceId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
});

afterEach(() => {
  setNotificationsBaseDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("notifications route", () => {
  it("marks historical heartbeat pollution as hidden while preserving real cron notifications", async () => {
    const result = await invoke();
    expect(result.status).toBe(200);
    expect(result.json.notifications).toEqual([
      expect.objectContaining({ seq: 1, hidden: true, jobName: "heartbeat-main" }),
      expect.objectContaining({ seq: 2, hidden: true }),
      expect.not.objectContaining({ seq: 3, hidden: true }),
      expect.objectContaining({ seq: 4, hidden: true }),
    ]);
  });
});
