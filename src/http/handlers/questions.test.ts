import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod }));

import { handleQuestionAnswer, handleQuestionLookup, handlePendingQuestions } from "./questions.js";

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;
type Captured = { statusCode: number; body: string };

const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";

const PENDING_RECORD = {
  id: QUESTION_ID,
  status: "pending",
  expiresAtMs: 1788842619679,
  questions: [
    {
      questionId: "deployment_environment",
      header: "部署环境",
      question: "要部署到哪个环境？",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
};

const PENDING_MULTI_RECORD = {
  ...PENDING_RECORD,
  questions: [
    {
      questionId: "deployment_environment",
      header: "部署环境",
      question: "要部署到哪个环境？",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
    {
      questionId: "with_runbook",
      header: "要跑书吗",
      question: "是否附带部署 runbook？",
      multiSelect: true,
      options: [{ label: "基础版" }, { label: "详细版" }, { label: "不需要" }],
    },
  ],
};

function makeGetReq(questionId: string, token = "test-token"): IncomingMessageLike {
  const req = Readable.from([]) as unknown as IncomingMessageLike;
  req.method = "GET";
  req.url = `/friday-next/questions/${questionId}`;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  return req;
}

async function lookup(questionId: string, token?: string) {
  const { res, captured } = makeRes();
  await handleQuestionLookup(makeGetReq(questionId, token), res, questionId);
  return {
    status: captured.statusCode,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

function makeReq(method: string, body?: unknown, token = "test-token"): IncomingMessageLike {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf-8")];
  const req = Readable.from(payload) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = `/friday-next/questions/${QUESTION_ID}`;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  return req;
}

function makeRes(): { res: ServerResponseLike; captured: Captured } {
  const captured: Captured = { statusCode: 200, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(v: number) {
      captured.statusCode = v;
    },
    setHeader() {},
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  return { res, captured };
}

async function invoke(method: string, questionId: string, body?: unknown, token?: string) {
  const { res, captured } = makeRes();
  await handleQuestionAnswer(makeReq(method, body, token), res, questionId);
  return {
    status: captured.statusCode,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

function mockGet(record: unknown) {
  dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { question: record } });
}

describe("handleQuestionAnswer", () => {
  beforeEach(() => {
    setMockRuntime();
    dispatchGatewayMethod.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing bearer", async () => {
    const result = await invoke("POST", QUESTION_ID, { optionValue: "Staging" }, "");
    expect(result.status).toBe(401);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("rejects a body with no answer", async () => {
    const result = await invoke("POST", QUESTION_ID, { deviceId: "DEV1" });
    expect(result.status).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("rejects a body with both optionValue and text", async () => {
    const result = await invoke("POST", QUESTION_ID, { optionValue: "Staging", text: "x" });
    expect(result.status).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("resolves an option answer, mapping the record id to the inner question id", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: true,
      payload: {
        status: "answered",
        answers: { answers: { deployment_environment: ["Staging"] } },
      },
    });

    const result = await invoke("POST", QUESTION_ID, { optionValue: "Staging", deviceId: "dev1" });

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, questionId: QUESTION_ID, status: "answered" });
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(1, "question.get", { id: QUESTION_ID });
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(2, "question.resolve", {
      id: QUESTION_ID,
      answers: { answers: { deployment_environment: ["Staging"] } },
      resolvedBy: "DEV1",
    });
  });

  it("resolves a free-text answer (the isOther custom path)", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });

    const result = await invoke("POST", QUESTION_ID, { text: "先发灰度 10%" });

    expect(result.status).toBe(200);
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(2, "question.resolve", {
      id: QUESTION_ID,
      answers: { answers: { deployment_environment: ["先发灰度 10%"] } },
    });
  });

  it("rejects an optionValue that is not a declared option", async () => {
    mockGet(PENDING_RECORD);
    const result = await invoke("POST", QUESTION_ID, { optionValue: "Canary" });
    expect(result.status).toBe(400);
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(1);
  });

  it("returns already-terminal when the record is gone", async () => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "not found",
        details: { reason: "QUESTION_NOT_FOUND" },
      },
    });
    const result = await invoke("POST", QUESTION_ID, { optionValue: "Staging" });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ status: "already-terminal", reason: "not-found" });
  });

  it("returns already-terminal when the record is no longer pending", async () => {
    mockGet({ ...PENDING_RECORD, status: "answered", answers: { answers: {} } });
    const result = await invoke("POST", QUESTION_ID, { optionValue: "Staging" });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ status: "already-terminal", terminalStatus: "answered" });
  });

  it("maps a resolve race against timeout to already-terminal, not an error", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "terminal",
        details: { reason: "QUESTION_ALREADY_TERMINAL" },
      },
    });
    const result = await invoke("POST", QUESTION_ID, { optionValue: "Staging" });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      status: "already-terminal",
      reason: "QUESTION_ALREADY_TERMINAL",
    });
  });

  it("returns 502 on an unexpected resolve failure", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: false,
      error: { code: "UNAVAILABLE", message: "boom" },
    });
    const result = await invoke("POST", QUESTION_ID, { optionValue: "Staging" });
    expect(result.status).toBe(502);
  });

  it("rejects multi-question records (not card-eligible)", async () => {
    mockGet({
      ...PENDING_RECORD,
      questions: [PENDING_RECORD.questions[0], PENDING_RECORD.questions[0]],
    });
    const result = await invoke("POST", QUESTION_ID, { optionValue: "Staging" });
    expect(result.status).toBe(400);
  });

  it("does not resolve the same answer twice when the app retries", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });
    const first = await invoke("POST", QUESTION_ID, { optionValue: "Staging" });
    const replay = await invoke("POST", QUESTION_ID, { optionValue: "Staging" });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.json?.replayed).toBe(true);
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(2); // get + resolve, once
  });

  it("rejects a conflicting second answer for the same question", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });
    expect((await invoke("POST", QUESTION_ID, { optionValue: "Staging" })).status).toBe(200);
    const replay = await invoke("POST", QUESTION_ID, { optionValue: "Production" });
    expect(replay.status).toBe(409);
  });
});

describe("handleQuestionLookup", () => {
  beforeEach(() => {
    setMockRuntime();
    dispatchGatewayMethod.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects missing bearer", async () => {
    const result = await lookup(QUESTION_ID, "");
    expect(result.status).toBe(401);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("returns pending question details incl. expiry", async () => {
    mockGet(PENDING_RECORD);
    const result = await lookup(QUESTION_ID);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      ok: true,
      questionId: QUESTION_ID,
      status: "pending",
      expiresAtMs: 1788842619679,
    });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("question.get", { id: QUESTION_ID });
  });

  it("returns terminal state for resolved questions", async () => {
    mockGet({ ...PENDING_RECORD, status: "expired" });
    const result = await lookup(QUESTION_ID);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ status: "expired" });
    expect(result.json?.questions).toBeUndefined();
  });

  it("maps a missing question to status not-found", async () => {
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "nf", details: { reason: "QUESTION_NOT_FOUND" } },
    });
    const result = await lookup(QUESTION_ID);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ status: "not-found" });
  });
});

describe("handleQuestionAnswer structured shapes", () => {
  beforeEach(() => {
    setMockRuntime();
    dispatchGatewayMethod.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a multi-select single question via values", async () => {
    mockGet({
      ...PENDING_RECORD,
      questions: [{ ...PENDING_RECORD.questions[0], multiSelect: true }],
    });
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });

    const result = await invoke("POST", QUESTION_ID, { values: ["Staging", "Production"] });

    expect(result.status).toBe(200);
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(2, "question.resolve", {
      id: QUESTION_ID,
      answers: { answers: { deployment_environment: ["Staging", "Production"] } },
    });
  });

  it("resolves a multi-question record via the answers map", async () => {
    mockGet(PENDING_MULTI_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });

    const result = await invoke("POST", QUESTION_ID, {
      answers: {
        deployment_environment: ["Staging"],
        with_runbook: ["详细版"],
      },
    });

    expect(result.status).toBe(200);
    expect(dispatchGatewayMethod).toHaveBeenNthCalledWith(2, "question.resolve", {
      id: QUESTION_ID,
      answers: {
        answers: { deployment_environment: ["Staging"], with_runbook: ["详细版"] },
      },
    });
  });

  it("rejects an answers map referencing an undeclared question id", async () => {
    mockGet(PENDING_MULTI_RECORD);
    const result = await invoke("POST", QUESTION_ID, {
      answers: { deployment_environment: ["Staging"], mystery: ["x"] },
    });
    expect(result.status).toBe(400);
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(1);
  });

  it("rejects a scalar shape against a multi-question record", async () => {
    mockGet(PENDING_MULTI_RECORD);
    const result = await invoke("POST", QUESTION_ID, { optionValue: "Staging" });
    expect(result.status).toBe(400);
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(1);
  });
});

describe("ask_user 失败恢复与跳过", () => {
  beforeEach(() => {
    setMockRuntime();
    dispatchGatewayMethod.mockReset();
  });
  it("首次网关失败后允许修改答案重试", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: false,
      error: { code: "UNAVAILABLE", message: "temporary failure" },
    });
    expect((await invoke("POST", QUESTION_ID, { optionValue: "Staging" })).status).toBe(502);
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });
    expect((await invoke("POST", QUESTION_ID, { optionValue: "Production" })).status).toBe(200);
  });
  it("输入被拒绝后可以提交修正答案", async () => {
    mockGet(PENDING_RECORD);
    expect((await invoke("POST", QUESTION_ID, { optionValue: "Canary" })).status).toBe(400);
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });
    expect((await invoke("POST", QUESTION_ID, { optionValue: "Staging" })).status).toBe(200);
  });
  it("接受独立于 label 的 canonical value", async () => {
    mockGet({
      ...PENDING_RECORD,
      questions: [
        {
          questionId: "target",
          header: "目标",
          question: "选择？",
          options: [{ label: "生产", value: "prod-id" }],
          isOther: true,
        },
      ],
    });
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });
    expect((await invoke("POST", QUESTION_ID, { optionValue: "prod-id" })).status).toBe(200);
    expect(dispatchGatewayMethod).toHaveBeenLastCalledWith("question.resolve", {
      id: QUESTION_ID,
      answers: { answers: { target: ["prod-id"] } },
    });
  });
  it("跳过询问使用 question.resolve cancel，且可幂等重试", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "cancelled" } });
    const first = await invoke("POST", QUESTION_ID, { cancel: true, deviceId: "dev1" });
    expect(first.status).toBe(200);
    expect(first.json?.status).toBe("cancelled");
    expect(dispatchGatewayMethod).toHaveBeenLastCalledWith("question.resolve", {
      id: QUESTION_ID,
      cancel: true,
      resolvedBy: "DEV1",
    });
    expect(
      (await invoke("POST", QUESTION_ID, { cancel: true, deviceId: "dev1" })).json?.replayed,
    ).toBe(true);
  });
  it("取消与答案不能混发", async () => {
    expect((await invoke("POST", QUESTION_ID, { cancel: true, text: "不要执行" })).status).toBe(
      400,
    );
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });
});

describe("待答恢复快照与并发回执", () => {
  beforeEach(() => {
    setMockRuntime();
    dispatchGatewayMethod.mockReset();
  });
  it("待答列表按完整会话过滤并排除终态、过期和秘密输入", async () => {
    const row = {
      ...PENDING_RECORD,
      expiresAtMs: Date.now() + 60_000,
      runId: "music-run",
      sessionKey: "agent:main:fridaynext:music",
    };
    dispatchGatewayMethod.mockResolvedValueOnce({
      ok: true,
      payload: {
        questions: [
          row,
          { ...row, id: "other", sessionKey: "agent:main:fridaynext:other" },
          { ...row, id: "done", status: "answered" },
          { ...row, id: "old", expiresAtMs: 1 },
          { ...row, id: "secret", questions: [{ questionId: "key", isSecret: true }] },
        ],
      },
    });
    const req = makeGetReq(QUESTION_ID);
    req.url = "/friday-next/questions?sessionKey=Agent%3AMain%3AFridayNext%3AMusic";
    const { res, captured } = makeRes();
    await handlePendingQuestions(req, res);
    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]).toMatchObject({ questionId: QUESTION_ID, runId: "music-run" });
  });
  it("列表查询失败不能伪装成没有待答问题", async () => {
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: false, error: { message: "offline" } });
    const req = makeGetReq(QUESTION_ID);
    req.url = "/friday-next/questions?sessionKey=agent:main:music";
    const { res, captured } = makeRes();
    await handlePendingQuestions(req, res);
    expect(captured.statusCode).toBe(502);
  });
  it("兼容旧版本失败遗留的 prepared 回执", async () => {
    getRuntimeV3Store().prepareCommandReceipt("question", QUESTION_ID, {
      optionValue: "bad",
      deviceId: "",
    });
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });
    expect((await invoke("POST", QUESTION_ID, { optionValue: "Staging" })).status).toBe(200);
    expect(getRuntimeV3Store().commandReceipt("question", QUESTION_ID)?.state).toBe("succeeded");
  });
  it("同一答案并发重试只调用一次核心 resolve", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });
    const results = await Promise.all([
      invoke("POST", QUESTION_ID, { optionValue: "Staging" }),
      invoke("POST", QUESTION_ID, { optionValue: "Staging" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[1].json?.replayed).toBe(true);
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(2);
  });
  it("并发冲突答案不能覆盖已经接受的结果", async () => {
    mockGet(PENDING_RECORD);
    dispatchGatewayMethod.mockResolvedValueOnce({ ok: true, payload: { status: "answered" } });
    const results = await Promise.all([
      invoke("POST", QUESTION_ID, { optionValue: "Staging" }),
      invoke("POST", QUESTION_ID, { optionValue: "Production" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 409]);
    expect(dispatchGatewayMethod).toHaveBeenCalledTimes(2);
  });
});
