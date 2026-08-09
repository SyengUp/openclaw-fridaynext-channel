// Tests for the gateway-side per-agent home-greeting store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_GREETING_LEN,
  readGreetingFor,
  readGreetings,
  setAgentGreetingsBaseDirForTest,
  setGreeting,
  validateGreeting,
} from "./greetings-store.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-greetings-"));
  setAgentGreetingsBaseDirForTest(dir);
});

afterEach(() => {
  setAgentGreetingsBaseDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("greetings store", () => {
  it("reads empty when no file exists", () => {
    expect(readGreetings().greetings).toEqual({});
    expect(readGreetingFor("main")).toBeUndefined();
  });

  it("round-trips a written greeting per agent", () => {
    setGreeting("main", "早上好");
    setGreeting("alpha", "需要我做什么？");
    expect(readGreetingFor("main")).toBe("早上好");
    expect(readGreetingFor("alpha")).toBe("需要我做什么？");
    // Other agents stay untouched.
    expect(readGreetingFor("beta")).toBeUndefined();
  });

  it("normalizes the agent id as the storage key", () => {
    setGreeting("MyAgent", "你好");
    expect(readGreetingFor("myagent")).toBe("你好");
    expect(readGreetingFor("MyAgent")).toBe("你好");
  });

  it("clears the override with an empty write", () => {
    setGreeting("main", "早上好");
    setGreeting("main", "");
    expect(readGreetingFor("main")).toBeUndefined();
  });

  it("overwrites an existing override", () => {
    setGreeting("main", "旧问句");
    setGreeting("main", "新问句");
    expect(readGreetingFor("main")).toBe("新问句");
  });

  it("degrades a corrupt file to empty instead of throwing", () => {
    setGreeting("main", "好问句");
    fs.writeFileSync(path.join(dir, "greetings.json"), "{not json");
    expect(readGreetingFor("main")).toBeUndefined();
    expect(readGreetings().greetings).toEqual({});
  });

  it("ignores wrong-typed values in a tampered file", () => {
    fs.writeFileSync(
      path.join(dir, "greetings.json"),
      JSON.stringify({ updatedAt: "yesterday", greetings: { main: 42, alpha: "" } }),
    );
    const state = readGreetings();
    expect(state.updatedAt).toBe(0);
    expect(state.greetings).toEqual({});
  });
});

describe("validateGreeting", () => {
  it("trims and accepts a normal greeting", () => {
    const r = validateGreeting("  需要我做什么？  ");
    expect(r).toEqual({ ok: true, greeting: "需要我做什么？" });
  });

  it("accepts empty (clears the override)", () => {
    expect(validateGreeting("")).toEqual({ ok: true, greeting: "" });
    expect(validateGreeting("   ")).toEqual({ ok: true, greeting: "" });
  });

  it("rejects non-strings", () => {
    expect(validateGreeting(42).ok).toBe(false);
    expect(validateGreeting(null).ok).toBe(false);
    expect(validateGreeting({ greeting: "x" }).ok).toBe(false);
  });

  it("rejects over-length greetings", () => {
    expect(validateGreeting("问".repeat(MAX_GREETING_LEN)).ok).toBe(true);
    expect(validateGreeting("问".repeat(MAX_GREETING_LEN + 1)).ok).toBe(false);
  });
});
