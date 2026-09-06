import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensurePrivateDirectory, writePrivateFile } from "./private-file.js";

const mode = (path: string): number => statSync(path).mode & 0o777;

describe.skipIf(process.platform === "win32")("private public-access state", () => {
  it("creates state directories as 0700", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "fn-private-dir-")), "nested");
    ensurePrivateDirectory(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("creates secrets as 0600 and tightens an existing permissive file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fn-private-file-"));
    const fresh = join(dir, "fresh.key");
    writePrivateFile(fresh, "secret");
    expect(mode(fresh)).toBe(0o600);

    const existing = join(dir, "existing.key");
    writeFileSync(existing, "old", { mode: 0o644 });
    writePrivateFile(existing, "new");
    expect(mode(existing)).toBe(0o600);
  });
});
