import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearFileIndexForTest,
  resolveServerLocalFile,
  setAttachmentsDirForTest,
} from "./files.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-server-local-"));
  setAttachmentsDirForTest(tmpDir);
  clearFileIndexForTest();
});

afterEach(() => {
  setAttachmentsDirForTest(null);
  clearFileIndexForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("server-local path reads (agent markdown file links)", () => {
  it("reads an absolute path inside the attachments base", () => {
    const target = path.join(tmpDir, "qweather.py");
    fs.writeFileSync(target, "print('ok')");
    const out = resolveServerLocalFile(target);
    expect(out?.buffer.toString()).toBe("print('ok')");
    expect(out?.filename).toBe("qweather.py");
  });

  it("accepts file:// prefixed tokens", () => {
    const target = path.join(tmpDir, "SKILL.md");
    fs.writeFileSync(target, "# skill");
    const out = resolveServerLocalFile(`file://${target}`);
    expect(out?.buffer.toString()).toBe("# skill");
    expect(out?.mimeType).toBe("text/markdown");
    expect(out?.filename).toBe("SKILL.md");
  });

  it("reads from the OpenClaw workspace dir", () => {
    const ws = path.join(os.homedir(), ".openclaw", "workspace");
    const target = path.join(ws, "skills", "qweather-query", "qweather.py");
    if (fs.existsSync(target)) {
      const out = resolveServerLocalFile(target);
      expect(out?.filename).toBe("qweather.py");
    } else {
      expect(resolveServerLocalFile(target)).toBeNull();
    }
  });

  it("rejects paths outside trusted bases", () => {
    const outside = path.join(os.tmpdir(), "fn-secret.txt");
    fs.writeFileSync(outside, "secret");
    expect(resolveServerLocalFile(outside)).toBeNull();
    fs.rmSync(outside, { force: true });
  });

  it("rejects dot-dot traversal that escapes the base", () => {
    const target = path.join(tmpDir, "..", "fn-traversal.txt");
    fs.writeFileSync(target, "nope");
    expect(resolveServerLocalFile(target)).toBeNull();
    fs.rmSync(target, { force: true });
  });

  it("returns null for missing files and non-path tokens", () => {
    expect(resolveServerLocalFile("/no/such/file.md")).toBeNull();
    expect(resolveServerLocalFile("plain-token")).toBeNull();
    expect(resolveServerLocalFile("")).toBeNull();
    expect(resolveServerLocalFile("http://example.com/x.md")).toBeNull();
  });

  it("returns null for directories", () => {
    expect(resolveServerLocalFile(tmpDir)).toBeNull();
  });
});
