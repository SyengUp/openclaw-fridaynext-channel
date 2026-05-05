/**
 * Self-test: path collection + resolve (no OpenClaw gateway).
 * Run from repo root:
 *   node --experimental-strip-types ./scripts/selftest-attachment.ts
 *
 * Simulates message tool result/params shapes for "send Desktop image.png".
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectMediaPathsFromToolResult,
  extractLocalPathsFromToolTextBlob,
} from "../src/collect-message-media-paths.ts";
import { normalizeAgentMediaPath, resolveMediaAttachment } from "../src/http/handlers/files.ts";

function desktopImageScenario() {
  const desktop = path.join(os.homedir(), "Desktop");
  const target = path.join(desktop, "image.png");
  if (!fs.existsSync(target)) {
    console.log(`[skip] No file at ${target} (create it or use a path that exists).`);
    return;
  }

  const paramsOnly = {
    action: "send",
    media: "~/Desktop/image.png",
  };
  const paths = collectMediaPathsFromToolResult({});
  for (const p of collectMediaPathsFromToolResult(paramsOnly)) paths.add(p);
  assert.equal(paths.size >= 1, true, "should collect ~/Desktop/image.png from params");
  const first = [...paths][0];
  assert.ok(first.includes("image.png"));

  const norm = normalizeAgentMediaPath(first);
  assert.equal(fs.existsSync(norm), true, `expanded path should exist: ${norm}`);

  const resolved = resolveMediaAttachment(first);
  assert.ok(resolved, "resolveMediaAttachment should copy into attachments/");
  assert.ok(resolved!.url.startsWith("/friday-next/files/"));
  console.log("[ok] desktop scenario:", resolved);
}

function tempFileScenario() {
  const tmp = path.join(os.tmpdir(), `friday-selftest-${Date.now()}.png`);
  fs.writeFileSync(
    tmp,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );

  const resultJson = JSON.stringify({ details: { mediaUrl: tmp } });
  const paths = collectMediaPathsFromToolResult(JSON.parse(resultJson));
  assert.ok(paths.has(tmp), "should collect absolute path from nested JSON");

  const toolLike = {
    result: { ok: true },
    params: { media: tmp, filePath: tmp },
  };
  const merged = collectMediaPathsFromToolResult(toolLike.result);
  for (const p of collectMediaPathsFromToolResult(toolLike.params)) merged.add(p);
  assert.ok(merged.has(tmp), "merge params + result should include media path");

  const resolved = resolveMediaAttachment(tmp);
  assert.ok(resolved);
  console.log("[ok] temp file scenario:", resolved);
}

function fileUrlScenario() {
  const tmp = path.join(os.tmpdir(), `friday-fileurl-${Date.now()}.png`);
  fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const fileUrl = pathToFileURL(tmp).href;
  const paths = collectMediaPathsFromToolResult({ media: fileUrl });
  assert.ok(paths.has(fileUrl));

  const resolved = resolveMediaAttachment(fileUrl);
  assert.ok(resolved);
  console.log("[ok] file:// scenario:", resolved);
}

/** Same shape as OpenClaw message tool end `text` (content[].text holds stringified JSON with mediaUrls). */
function nestedMarkdownToolTextScenario() {
  const tmp = path.join(os.tmpdir(), `friday-prd-${Date.now()}.md`);
  fs.writeFileSync(tmp, "# PRD\n");

  const inner = JSON.stringify({
    channel: "friday-next",
    mediaUrl: tmp,
    mediaUrls: [tmp],
    result: { messageId: "x" },
  });
  const outer = {
    content: [{ type: "text", text: inner }],
    details: { channel: "friday-next", mediaUrl: tmp, mediaUrls: [tmp] },
  };
  const paths = collectMediaPathsFromToolResult(outer);
  assert.ok(paths.has(tmp), "should lift .md path from content[].text JSON");
  const resolved = resolveMediaAttachment(tmp);
  assert.ok(resolved);
  assert.ok(resolved!.fileName.endsWith(".md"));
  console.log("[ok] nested message tool (markdown) scenario:", resolved);
}

tempFileScenario();
fileUrlScenario();
nestedMarkdownToolTextScenario();

function stringifyBlobExtractionScenario() {
  const inner = JSON.stringify({
    channel: "friday-next",
    mediaUrl: "/Users/syengup/Desktop/PRD.md",
    mediaUrls: ["/Users/syengup/Desktop/PRD.md"],
  });
  const obj = {
    content: [{ type: "text", text: inner }],
    details: { mediaUrl: "/Users/syengup/Desktop/PRD.md" },
  };
  const text = JSON.stringify(obj);
  const fromBlob = extractLocalPathsFromToolTextBlob(text);
  assert.ok(fromBlob.has("/Users/syengup/Desktop/PRD.md"));
  console.log("[ok] JSON.stringify blob extraction (PRD.md path)");
}

stringifyBlobExtractionScenario();
desktopImageScenario();
console.log("selftest-attachment: all runnable checks passed.");
