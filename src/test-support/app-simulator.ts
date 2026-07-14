import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { registerFridayNextHttpRoutes } from "../http/server.js";

type Headers = Record<string, string>;

export type SseFrame = {
  id?: number;
  event?: string;
  data?: Record<string, unknown>;
  raw: string;
};

class MockReq extends Readable {
  method: string;
  url: string;
  headers: Record<string, string>;

  constructor(method: string, url: string, headers: Record<string, string>, body?: Buffer) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    if (body && body.length > 0) this.push(body);
    this.push(null);
  }

  _read(): void {
    // no-op
  }
}

class MockRes extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = Buffer.alloc(0);
  writes: string[] = [];
  headersSent = false;

  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.writes.push(buf.toString("utf-8"));
    this.body = Buffer.concat([this.body, buf]);
    cb();
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = String(value);
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  end(chunk?: Buffer | string): this {
    if (chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.writes.push(buf.toString("utf-8"));
      this.body = Buffer.concat([this.body, buf]);
    }
    this.emit("finish");
    return this;
  }
}

type HarnessHandler = (
  req: Readable & { method?: string; url?: string },
  res: Writable,
) => Promise<boolean>;

function createRouteHarness(): HarnessHandler {
  // Mirror the gateway's route table: registerFridayNextHttpRoutes registers
  // MULTIPLE routes (the /friday-next prefix + siblings like /friday-next-admin/*),
  // so the harness must dispatch by path like the real server — keeping only the
  // last-registered handler silently routes every request to the wrong endpoint.
  const routes: Array<{ path: string; match: string; handler: HarnessHandler }> = [];
  const fakeApi = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    registerHttpRoute(route: {
      path: string;
      match: string;
      handler: (req: never, res: never) => Promise<boolean>;
    }) {
      routes.push({ path: route.path, match: route.match, handler: route.handler as never });
    },
  };
  registerFridayNextHttpRoutes(fakeApi as never);
  if (routes.length === 0) throw new Error("route handler not registered");
  return async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    // Longest-path match first so /friday-next-admin/* wins over the /friday-next prefix.
    const sorted = [...routes].sort((a, b) => b.path.length - a.path.length);
    for (const route of sorted) {
      const matched =
        route.match === "exact"
          ? pathname === route.path
          : pathname === route.path || pathname.startsWith(`${route.path}/`);
      if (matched) return route.handler(req, res);
    }
    throw new Error(`no registered route matches ${pathname}`);
  };
}

function parseSseFrames(rawChunks: string[]): SseFrame[] {
  const frames: SseFrame[] = [];
  const joined = rawChunks.join("");
  for (const raw of joined.split("\n\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;
    const frame: SseFrame = { raw };
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("id:")) frame.id = Number.parseInt(line.slice(3).trim(), 10);
      if (line.startsWith("event:")) frame.event = line.slice(6).trim();
      if (line.startsWith("data:")) {
        const text = line.slice(5).trim();
        try {
          frame.data = JSON.parse(text) as Record<string, unknown>;
        } catch {
          frame.data = { raw: text };
        }
      }
    }
    frames.push(frame);
  }
  return frames;
}

function jsonBody(res: MockRes): Record<string, unknown> {
  const text = res.body.toString("utf-8");
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  tickMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

export function createAppSimulator(opts?: { deviceId?: string; token?: string }) {
  const routeHandler = createRouteHarness();
  const token = opts?.token ?? "test-token";
  const deviceId = opts?.deviceId ?? "DEV-A";

  let sseReq: (Readable & EventEmitter) | null = null;
  let sseRes: MockRes | null = null;

  const request = async (arg: {
    method: string;
    path: string;
    headers?: Headers;
    body?: Buffer | string;
  }): Promise<MockRes> => {
    const headers = {
      authorization: `Bearer ${token}`,
      ...(arg.headers ?? {}),
    };
    const body = typeof arg.body === "string" ? Buffer.from(arg.body) : arg.body;
    const req = new MockReq(arg.method, arg.path, headers, body);
    const res = new MockRes();
    await routeHandler(req as never, res as never);
    return res;
  };

  return {
    async connectSSE(arg?: { deviceId?: string; lastEventId?: number; token?: string }) {
      const did = (arg?.deviceId ?? deviceId).trim();
      const headers: Headers = { authorization: `Bearer ${arg?.token ?? token}` };
      const q = new URLSearchParams({ deviceId: did });
      if (arg?.lastEventId != null && arg.lastEventId > 0) {
        q.set("lastEventId", String(arg.lastEventId));
        headers["last-event-id"] = String(arg.lastEventId);
      }
      sseReq = new MockReq("GET", `/friday-next/events?${q.toString()}`, headers);
      sseRes = new MockRes();
      await routeHandler(sseReq as never, sseRes as never);
      return sseRes;
    },
    disconnectSSE() {
      sseReq?.emit("close");
      sseReq = null;
      sseRes = null;
    },
    getSseFrames(): SseFrame[] {
      return parseSseFrames(sseRes?.writes ?? []);
    },
    async waitForSse(predicate: (frames: SseFrame[]) => boolean, timeoutMs = 2000) {
      await waitFor(() => predicate(parseSseFrames(sseRes?.writes ?? [])), timeoutMs);
      return parseSseFrames(sseRes?.writes ?? []);
    },
    async sendMessage(arg: {
      text?: string;
      deviceId?: string;
      sessionKey?: string;
      attachments?: string[];
    }) {
      const payload = {
        deviceId: arg.deviceId ?? deviceId,
        text: arg.text ?? "",
        sessionKey: arg.sessionKey ?? "s1",
        attachments: arg.attachments ?? [],
      };
      const res = await request({
        method: "POST",
        path: "/friday-next/messages",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: res.statusCode, body: jsonBody(res) };
    },
    async uploadFiles(
      parts: Array<{
        name: string;
        filename: string;
        contentType: string;
        content: string | Buffer;
      }>,
    ) {
      const boundary = "----friday-next-e2e-boundary";
      const chunks: Buffer[] = [];
      for (const part of parts) {
        const head =
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
          `Content-Type: ${part.contentType}\r\n\r\n`;
        chunks.push(Buffer.from(head));
        chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
        chunks.push(Buffer.from("\r\n"));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      const res = await request({
        method: "POST",
        path: "/friday-next/files",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(chunks),
      });
      return { status: res.statusCode, body: jsonBody(res) };
    },
    async downloadFile(url: string, headers?: Headers) {
      const res = await request({ method: "GET", path: url, headers });
      return { status: res.statusCode, body: res.body, headers: res.headers };
    },
    async cancel(runId: string) {
      const res = await request({
        method: "POST",
        path: "/friday-next/cancel",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      return { status: res.statusCode, body: jsonBody(res) };
    },
    async status() {
      const res = await request({ method: "GET", path: "/friday-next/status" });
      return { status: res.statusCode, body: jsonBody(res), headers: res.headers };
    },
    async options(path: string, origin = "https://example.com") {
      const res = await request({ method: "OPTIONS", path, headers: { origin } });
      return { status: res.statusCode, headers: res.headers };
    },
    async rawRequest(arg: {
      method: string;
      path: string;
      headers?: Headers;
      body?: string | Buffer;
    }) {
      const res = await request(arg);
      return { status: res.statusCode, body: res.body.toString("utf-8"), headers: res.headers };
    },
  };
}
