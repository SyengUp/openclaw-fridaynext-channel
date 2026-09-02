import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "../agent-forward-runtime.js";
import { sseEmitter } from "../sse/emitter.js";
import {
  hasExplicitSessionName,
  maybeGenerateSessionTitle,
  normalizeSessionTitle,
  resetTitleCompletionSdkForTest,
  setTitleCompletionSdkForTest,
  truncateTitleText,
  type TitleCompletionSdk,
} from "./session-title-generator.js";

const CFG = {
  channels: { "friday-next": { authToken: "test-token", pathPrefix: "/friday-next" } },
  gateway: { auth: { token: "test-token" } },
};

const KEY = "agent:main:fridaynext:abc123";

type Store = Record<string, { sessionId?: string; displayName?: string; label?: string }>;

function makeRuntime(store: Store): void {
  setFridayAgentForwardRuntime({
    runtime: {
      agent: {
        session: {
          resolveStorePath: (_s?: string, opts?: { agentId?: string }) =>
            `/store/${opts?.agentId ?? "main"}.json`,
          getSessionEntry: ({ sessionKey }: { sessionKey: string }) =>
            store[sessionKey] ?? store[sessionKey.toLowerCase()] ?? undefined,
          listSessionEntries: () =>
            Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry })),
          patchSessionEntry: async (params: {
            sessionKey: string;
            agentId?: string;
            update: (
              entry: Record<string, unknown>,
            ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
          }) => {
            const entry = store[params.sessionKey] ?? { sessionId: "sess-1" };
            const patch = await params.update(entry);
            if (patch) {
              store[params.sessionKey] = { ...entry, ...patch };
            }
            return store[params.sessionKey];
          },
        },
      },
      config: { current: () => CFG },
    },
  } as never);
}

type FakeSdk = {
  prepareSimpleCompletionModelForAgent: ReturnType<typeof vi.fn>;
  completeWithPreparedSimpleCompletionModel: ReturnType<typeof vi.fn>;
  extractAssistantText: ReturnType<typeof vi.fn>;
};

function makeFakeSdk(): FakeSdk {
  const sdk = {
    prepareSimpleCompletionModelForAgent: vi.fn(async () => ({ model: { id: "m" }, auth: {} })),
    completeWithPreparedSimpleCompletionModel: vi.fn(async () => ({
      content: [{ type: "text", text: "询问写诗能力" }],
    })),
    extractAssistantText: vi.fn((msg: { content?: Array<{ type: string; text?: string }> }) =>
      (msg.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n"),
    ),
  };
  setTitleCompletionSdkForTest(sdk as unknown as TitleCompletionSdk);
  return sdk;
}

describe("session-title-generator", () => {
  beforeEach(() => {
    sseEmitter.resetForTest();
    vi.restoreAllMocks();
    setTitleCompletionSdkForTest(null);
  });
  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    resetTitleCompletionSdkForTest();
  });

  describe("truncateTitleText", () => {
    it("keeps short text intact", () => {
      expect(truncateTitleText("你好", 60)).toBe("你好");
    });
    it("cuts by code points without splitting surrogate pairs", () => {
      expect(truncateTitleText("a😀b", 2)).toBe("a😀");
    });
  });

  describe("normalizeSessionTitle", () => {
    it("takes the first non-empty line", () => {
      expect(normalizeSessionTitle("  询问写诗能力  \n\n 第二行")).toBe("询问写诗能力");
    });
    it("strips a title: prefix case-insensitively", () => {
      expect(normalizeSessionTitle("Title: 询问写诗能力")).toBe("询问写诗能力");
      expect(normalizeSessionTitle("title: 询问写诗能力")).toBe("询问写诗能力");
    });
    it("strips surrounding quotes and backticks", () => {
      expect(normalizeSessionTitle('"询问写诗能力"')).toBe("询问写诗能力");
      expect(normalizeSessionTitle("`询问写诗能力`")).toBe("询问写诗能力");
    });
    it("collapses internal whitespace", () => {
      expect(normalizeSessionTitle("询问   写诗\n能力")).toBe("询问 写诗");
    });
    it("skips code-fence marker lines but keeps their content", () => {
      expect(normalizeSessionTitle("```\ncode\n```")).toBe("code");
      expect(normalizeSessionTitle("   ")).toBeNull();
    });
    it("caps at 60 characters", () => {
      const long = "字".repeat(70);
      expect(normalizeSessionTitle(long)).toBe("字".repeat(60));
    });
  });

  describe("hasExplicitSessionName", () => {
    it("true when label/displayName/subject exists", () => {
      expect(hasExplicitSessionName({ displayName: "已命名" })).toBe(true);
      expect(hasExplicitSessionName({ label: "x" })).toBe(true);
      expect(hasExplicitSessionName({ subject: "x" })).toBe(true);
    });
    it("false for empty or missing names", () => {
      expect(hasExplicitSessionName({ displayName: "  " })).toBe(false);
      expect(hasExplicitSessionName({})).toBe(false);
      expect(hasExplicitSessionName(null)).toBe(false);
      expect(hasExplicitSessionName(undefined)).toBe(false);
    });
  });

  describe("maybeGenerateSessionTitle", () => {
    it("generates, persists displayName and broadcasts a session-title event", async () => {
      const store: Store = { [KEY]: { sessionId: "sess-1" } };
      makeRuntime(store);
      const sdk = makeFakeSdk();
      const broadcast = vi.spyOn(sseEmitter, "broadcast");

      const result = await maybeGenerateSessionTitle({
        sessionKey: KEY,
        firstUserMessage: "你会写诗吗?",
        deviceId: "DEVICE-1",
      });

      expect(result).toBe(true);
      expect(store[KEY].displayName).toBe("询问写诗能力");
      expect(sdk.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", useUtilityModel: true }),
      );
      expect(sdk.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledOnce();
      expect(broadcast).toHaveBeenCalledWith(
        {
          type: "session-title",
          data: expect.objectContaining({
            sessionKey: KEY,
            title: "询问写诗能力",
            deviceId: "DEVICE-1",
          }),
        },
        "DEVICE-1",
        true,
      );
    });

    it("skips sessions that already carry an explicit name", async () => {
      const store: Store = { [KEY]: { sessionId: "sess-1", displayName: "已命名" } };
      makeRuntime(store);
      const sdk = makeFakeSdk();

      const result = await maybeGenerateSessionTitle({
        sessionKey: KEY,
        firstUserMessage: "你会写诗吗?",
        deviceId: "DEVICE-1",
      });

      expect(result).toBe(false);
      expect(sdk.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
      expect(store[KEY].displayName).toBe("已命名");
    });

    it("skips slash commands and empty messages", async () => {
      const store: Store = { [KEY]: { sessionId: "sess-1" } };
      makeRuntime(store);
      const sdk = makeFakeSdk();

      expect(
        await maybeGenerateSessionTitle({
          sessionKey: KEY,
          firstUserMessage: "/todo 买牛奶",
          deviceId: "DEVICE-1",
        }),
      ).toBe(false);
      expect(
        await maybeGenerateSessionTitle({
          sessionKey: KEY,
          firstUserMessage: "   ",
          deviceId: "DEVICE-1",
        }),
      ).toBe(false);
      expect(sdk.prepareSimpleCompletionModelForAgent).not.toHaveBeenCalled();
    });

    it("does not write when the model output does not normalize", async () => {
      const store: Store = { [KEY]: { sessionId: "sess-1" } };
      makeRuntime(store);
      const sdk = makeFakeSdk();
      sdk.extractAssistantText.mockReturnValue("   ");

      const result = await maybeGenerateSessionTitle({
        sessionKey: KEY,
        firstUserMessage: "你会写诗吗?",
        deviceId: "DEVICE-1",
      });

      expect(result).toBe(false);
      expect(store[KEY].displayName).toBeUndefined();
    });

    it("does not write when completion preparation fails and allows retry", async () => {
      const store: Store = { [KEY]: { sessionId: "sess-1" } };
      makeRuntime(store);
      const sdk = makeFakeSdk();
      sdk.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce({ error: "no model" });

      const first = await maybeGenerateSessionTitle({
        sessionKey: KEY,
        firstUserMessage: "你会写诗吗?",
        deviceId: "DEVICE-1",
      });
      expect(first).toBe(false);
      expect(store[KEY].displayName).toBeUndefined();

      const second = await maybeGenerateSessionTitle({
        sessionKey: KEY,
        firstUserMessage: "你会写诗吗?",
        deviceId: "DEVICE-1",
      });
      expect(second).toBe(true);
      expect(store[KEY].displayName).toBe("询问写诗能力");
    });

    it("dedupes concurrent requests for the same session", async () => {
      const store: Store = { [KEY]: { sessionId: "sess-1" } };
      makeRuntime(store);
      const sdk = makeFakeSdk();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      sdk.completeWithPreparedSimpleCompletionModel.mockImplementationOnce(
        async () => await gate.then(() => ({ content: [{ type: "text", text: "询问写诗能力" }] })),
      );

      const first = maybeGenerateSessionTitle({
        sessionKey: KEY,
        firstUserMessage: "你会写诗吗?",
        deviceId: "DEVICE-1",
      });
      const second = maybeGenerateSessionTitle({
        sessionKey: KEY,
        firstUserMessage: "你会写诗吗?",
        deviceId: "DEVICE-1",
      });

      expect(await second).toBe(false);
      release();
      expect(await first).toBe(true);
      expect(sdk.prepareSimpleCompletionModelForAgent).toHaveBeenCalledOnce();
    });

    it("resolves the canonical store key (case-insensitive)", async () => {
      const store: Store = { [KEY.toLowerCase()]: { sessionId: "sess-1" } };
      makeRuntime(store);
      const sdk = makeFakeSdk();

      const result = await maybeGenerateSessionTitle({
        sessionKey: KEY,
        firstUserMessage: "你会写诗吗?",
        deviceId: "DEVICE-1",
      });

      expect(result).toBe(true);
      expect(store[KEY.toLowerCase()].displayName).toBe("询问写诗能力");
    });

    it("does not clobber a name written while the model was thinking", async () => {
      const store: Store = { [KEY]: { sessionId: "sess-1" } };
      makeRuntime(store);
      const sdk = makeFakeSdk();
      // Race: user renames while completion is in flight.
      sdk.completeWithPreparedSimpleCompletionModel = async () => {
        store[KEY].displayName = "用户手改";
        return { content: [{ type: "text", text: "AI 标题" }] };
      };

      const result = await maybeGenerateSessionTitle({
        sessionKey: KEY,
        firstUserMessage: "你会写诗吗?",
        deviceId: "DEVICE-1",
      });

      expect(result).toBe(false);
      expect(store[KEY].displayName).toBe("用户手改");
    });
  });
});
