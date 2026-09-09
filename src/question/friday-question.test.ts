import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registerChannelDelivery } = vi.hoisted(() => ({
  registerChannelDelivery: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { registerChannelDelivery },
}));

import {
  __resetFridayQuestionsForTest,
  hasPendingFridayQuestion,
  noteFridayQuestionPrompt,
  readFridayAskUserBinding,
  terminalOpFromStatusLine,
} from "./friday-question.js";
import { sseEmitter } from "../sse/emitter.js";
import { setMockRuntime } from "../test-support/mock-runtime.js";

const QUESTION_ID = "ask_0123456789abcdef0123456789abcdef";

function lastBroadcast(deviceId: string) {
  const calls = vi.mocked(sseEmitter.broadcast).mock.calls;
  return calls.filter((c) => c[1] === deviceId).at(-1)?.[0];
}

describe("friday-question", () => {
  beforeEach(() => {
    setMockRuntime();
    __resetFridayQuestionsForTest();
    registerChannelDelivery.mockReset();
    vi.spyOn(sseEmitter, "broadcast").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetFridayQuestionsForTest();
  });

  it("marks a session as having a pending question, canonically keyed", () => {
    noteFridayQuestionPrompt({
      questionId: QUESTION_ID,
      sessionKey: "Agent:Main:FridayNext:CurlTest01",
      deviceId: "dev-1",
      runId: "run-1",
    });
    expect(hasPendingFridayQuestion("agent:main:fridaynext:curltest01")).toBe(true);
    expect(hasPendingFridayQuestion("agent:main:fridaynext:other")).toBe(false);
  });

  it("registers a channel delivery finalizer and broadcasts the terminal event with runId", () => {
    noteFridayQuestionPrompt({
      questionId: QUESTION_ID,
      sessionKey: "agent:main:fridaynext:s1",
      deviceId: "dev-1",
      runId: "run-1",
    });
    expect(registerChannelDelivery).toHaveBeenCalledTimes(1);
    const registration = registerChannelDelivery.mock.calls[0][0];
    expect(registration.questionId).toBe(QUESTION_ID);
    expect(registration.deliveryId).toContain("friday-next:DEV-1");

    registration.finalize("Answered: Production");

    expect(hasPendingFridayQuestion("agent:main:fridaynext:s1")).toBe(false);
    const event = lastBroadcast("DEV-1");
    expect(event?.type).toBe("question");
    expect(event?.data).toMatchObject({
      op: "resolved",
      questionId: QUESTION_ID,
      statusLine: "Answered: Production",
      answeredLabels: ["Production"],
      sessionKey: "agent:main:fridaynext:s1",
      runId: "run-1",
      deviceId: "DEV-1",
    });
  });

  it("maps Expired and Cancelled status lines", () => {
    expect(terminalOpFromStatusLine("Expired")).toEqual({ op: "expired", answeredLabels: [] });
    expect(terminalOpFromStatusLine("Cancelled")).toEqual({ op: "cancelled", answeredLabels: [] });
    expect(terminalOpFromStatusLine("Answered: A, B")).toEqual({
      op: "resolved",
      answeredLabels: ["A", "B"],
    });
    expect(terminalOpFromStatusLine("Answered")).toEqual({ op: "resolved", answeredLabels: [] });
  });

  it("is idempotent per questionId", () => {
    const params = {
      questionId: QUESTION_ID,
      sessionKey: "agent:main:fridaynext:s1",
      deviceId: "DEV1",
    };
    noteFridayQuestionPrompt(params);
    noteFridayQuestionPrompt(params);
    expect(registerChannelDelivery).toHaveBeenCalledTimes(1);
  });

  it("a new question supersedes the session's previous pending entry", () => {
    noteFridayQuestionPrompt({
      questionId: QUESTION_ID,
      sessionKey: "agent:main:fridaynext:s1",
      deviceId: "DEV1",
    });
    noteFridayQuestionPrompt({
      questionId: "ask_abcdef0123456789abcdef0123456789",
      sessionKey: "agent:main:fridaynext:s1",
      deviceId: "DEV1",
    });
    expect(registerChannelDelivery).toHaveBeenCalledTimes(2);
    // The first question's finalizer must not clear the second question's pending mark.
    registerChannelDelivery.mock.calls[0][0].finalize("Expired");
    expect(hasPendingFridayQuestion("agent:main:fridaynext:s1")).toBe(true);
  });

  it("drops pending state when the TTL backstop fires (gateway restart wipes core state)", () => {
    vi.useFakeTimers();
    try {
      noteFridayQuestionPrompt({
        questionId: QUESTION_ID,
        sessionKey: "agent:main:fridaynext:s1",
        deviceId: "DEV1",
      });
      vi.advanceTimersByTime(71 * 60 * 1000);
      expect(hasPendingFridayQuestion("agent:main:fridaynext:s1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the askUser binding off delivered payloads only", () => {
    expect(
      readFridayAskUserBinding({ channelData: { askUser: { questionId: QUESTION_ID } } }),
    ).toEqual({ questionId: QUESTION_ID });
    expect(readFridayAskUserBinding({ channelData: { fridayNext: {} } })).toBeUndefined();
    expect(
      readFridayAskUserBinding({ channelData: { askUser: { questionId: " " } } }),
    ).toBeUndefined();
    expect(readFridayAskUserBinding(null)).toBeUndefined();
    expect(readFridayAskUserBinding("text")).toBeUndefined();
  });
});
