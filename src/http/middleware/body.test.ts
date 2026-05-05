import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { readJsonBody } from "./body.js";

describe("readJsonBody", () => {
  it("parses valid json", async () => {
    const req = new PassThrough();
    const p = readJsonBody(req as never);
    req.end(JSON.stringify({ ok: true }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("returns null for invalid json", async () => {
    const req = new PassThrough();
    const p = readJsonBody(req as never);
    req.end("{");
    await expect(p).resolves.toBeNull();
  });

  it("returns null for oversized body", async () => {
    const req = new PassThrough();
    const p = readJsonBody(req as never, 8);
    req.write("123456789");
    req.end();
    await expect(p).resolves.toBeNull();
  });
});
