// Tests for the gateway-side server display-name store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SERVER_NAME_LEN,
  readServerName,
  setServerNameBaseDirForTest,
  validateServerName,
  writeServerName,
} from "./server-name-store.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-server-name-"));
  setServerNameBaseDirForTest(dir);
});

afterEach(() => {
  setServerNameBaseDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("server-name store", () => {
  it("reads empty when no file exists", () => {
    const state = readServerName();
    expect(state.name).toBe("");
    expect(state.updatedAt).toBe(0);
  });

  it("round-trips a written name", () => {
    const written = writeServerName("客厅的 Mac mini");
    expect(written.name).toBe("客厅的 Mac mini");
    expect(written.updatedAt).toBeGreaterThan(0);

    const read = readServerName();
    expect(read.name).toBe("客厅的 Mac mini");
    expect(read.updatedAt).toBe(written.updatedAt);
  });

  it("clears the name with an empty write", () => {
    writeServerName("旧名字");
    writeServerName("");
    expect(readServerName().name).toBe("");
  });

  it("degrades a corrupt file to empty instead of throwing", () => {
    writeServerName("好名字");
    fs.writeFileSync(path.join(dir, "server-name.json"), "{not json");
    expect(readServerName().name).toBe("");
  });

  it("ignores wrong-typed fields in a tampered file", () => {
    fs.writeFileSync(
      path.join(dir, "server-name.json"),
      JSON.stringify({ name: 42, updatedAt: "yesterday" }),
    );
    const state = readServerName();
    expect(state.name).toBe("");
    expect(state.updatedAt).toBe(0);
  });
});

describe("validateServerName", () => {
  it("trims and accepts a normal name", () => {
    const r = validateServerName("  书房服务器  ");
    expect(r).toEqual({ ok: true, name: "书房服务器" });
  });

  it("accepts empty (clears the name)", () => {
    expect(validateServerName("")).toEqual({ ok: true, name: "" });
  });

  it("rejects non-strings", () => {
    expect(validateServerName(42).ok).toBe(false);
    expect(validateServerName(null).ok).toBe(false);
    expect(validateServerName({ name: "x" }).ok).toBe(false);
  });

  it("rejects over-length names", () => {
    expect(validateServerName("名".repeat(MAX_SERVER_NAME_LEN)).ok).toBe(true);
    expect(validateServerName("名".repeat(MAX_SERVER_NAME_LEN + 1)).ok).toBe(false);
  });
});
