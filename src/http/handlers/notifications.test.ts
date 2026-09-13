import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cronResultStore, setInboxV2RootForTest } from "../../inbox/cron-result-store.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { handleNotifications } from "./notifications.js";

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;

const deviceId = "TRUSTED-CRON-DEVICE";
let root = "";

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
      notifications: Array<{ seq: number; kind: string; text: string; jobName?: string }>;
      maxSeq: number;
    },
  };
}

beforeEach(() => {
  setMockRuntime({ authToken: "test-token" });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-notification-route-"));
  setInboxV2RootForTest(path.join(root, "inbox-v2"));
  cronResultStore.resetForTest();
});

afterEach(() => {
  setInboxV2RootForTest(null);
  cronResultStore.resetForTest();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy notifications route", () => {
  it("只投影 inbox-v2 的结构化 cron 结果，不读取旧 push/heartbeat 日志", async () => {
    const legacyDir = path.join(root, "notifications");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, `${deviceId}.jsonl`),
      `${JSON.stringify({ seq: 99, kind: "push", text: "旧 heartbeat 污染" })}\n`,
      "utf8",
    );
    cronResultStore.append({
      sourceIdentity: "run:trusted",
      category: "cronResults",
      kind: "cronResult",
      lifecycle: "event",
      occurredAtMs: 123,
      deviceId,
      jobId: "job-1",
      jobName: "每日科技",
      agentId: "main",
      runId: "trusted",
      status: "ok",
      summary: "可信结果",
    });

    const result = await invoke();
    expect(result.status).toBe(200);
    expect(result.json.notifications).toEqual([
      expect.objectContaining({
        seq: 1,
        kind: "cron",
        text: "可信结果",
        jobName: "每日科技",
      }),
    ]);
    expect(result.json.maxSeq).toBe(1);
  });
});
