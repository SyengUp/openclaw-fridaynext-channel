import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { absoluteModuleSpecifier, importAbsoluteModule } from "./import-absolute-module.js";

describe("absoluteModuleSpecifier", () => {
  it("turns a POSIX absolute path into a file:// URL, not a bare specifier", () => {
    const spec = absoluteModuleSpecifier("/opt/homebrew/lib/node_modules/openclaw/dist/chunk.js");
    expect(spec.startsWith("file://")).toBe(true);
    expect(spec.startsWith("/")).toBe(false);
    expect(spec).toBe(
      pathToFileURL("/opt/homebrew/lib/node_modules/openclaw/dist/chunk.js").href,
    );
  });
});

describe("importAbsoluteModule", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("loads a real file via the file:// specifier", async () => {
    dir = mkdtempSync(join(tmpdir(), "fn-abs-import-"));
    const file = join(dir, "probe.mjs");
    writeFileSync(file, "export const marker = 'fn-abs-import';\n");
    const mod = (await importAbsoluteModule(file)) as { marker: string };
    expect(mod.marker).toBe("fn-abs-import");
  });
});
