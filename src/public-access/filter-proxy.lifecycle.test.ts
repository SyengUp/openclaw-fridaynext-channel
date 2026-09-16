import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startFilterProxy } from "./filter-proxy.js";

// SSE 走的是普通 HTTP（不是 upgrade）。此前客户端中途断开时，`req.pipe(upstream)` 只把
// 请求侧 half-close 到 core，core 的 SSE handler 永远等不到 close：连接、listener 与
// 写缓冲全部悬挂。实测 App 反复重连后网关留下一串死链（5 次重连 = 5 条 ESTABLISHED、
// 0 条 disconnect），之后每个事件被写 N 份——内存与 CPU 按悬挂数放大。
// upgrade 路径早已绑定两端生命周期（见 filter-proxy.ts 的 closeBoth 注释），HTTP/SSE 同理。

let core: Server;
let corePort = 0;
let proxy: Server;
let proxyPort = 0;
let coreCloseSignal: (() => void) | null = null;
let coreClosePromise: Promise<void> = Promise.resolve();

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve) => {
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
    if (!server.listening) server.listen(port, "127.0.0.1");
  });
}

beforeAll(async () => {
  core = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: hello\n\n");
    req.on("close", () => coreCloseSignal?.());
    // 保持流打开：SSE 语义，不 end。
  });
  corePort = await listen(core, 0);
  proxy = startFilterProxy(0, corePort, () => {}, {
    enabled: () => false,
    verify: () => false,
  });
  proxyPort = await listen(proxy, 0);
});

afterAll(async () => {
  proxy.closeAllConnections();
  core.closeAllConnections();
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

function expectUpstreamClose(withinMs: number): Promise<boolean> {
  coreClosePromise = new Promise<void>((resolve) => {
    coreCloseSignal = resolve;
  });
  return Promise.race([
    coreClosePromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), withinMs)),
  ]);
}

describe("filter proxy SSE lifecycle", () => {
  it("propagates a mid-stream client disconnect to the upstream request", async () => {
    const sawClose = expectUpstreamClose(2000);
    let streamStarted = false;

    await new Promise<void>((resolve) => {
      const clientReq = request(
        { host: "127.0.0.1", port: proxyPort, path: "/friday-next/v3/events?deviceId=TEST" },
        (res) => {
          res.once("data", () => {
            streamStarted = true;
            // 模拟 App 网络中断/强制重连：直接销毁 socket，不发 HTTP 语义的结束。
            res.destroy();
            clientReq.destroy();
            resolve();
          });
          res.resume();
        },
      );
      clientReq.on("error", () => {
        // abort 之后的本地 socket 错误属预期。
      });
      clientReq.end();
    });

    expect(streamStarted).toBe(true);
    expect(await sawClose).toBe(true);
  });

  it("does not tear down the upstream while the client keeps reading", async () => {
    const sawClose = expectUpstreamClose(600);
    let received = "";
    const clientReq = request(
      { host: "127.0.0.1", port: proxyPort, path: "/friday-next/v3/events?deviceId=TEST-KEEP" },
      (res) => {
        res.on("data", (chunk) => {
          received += String(chunk);
        });
      },
    );
    clientReq.on("error", () => {});
    clientReq.end();

    await new Promise((r) => setTimeout(r, 1000));
    expect(received).toContain("data: hello");
    expect(await sawClose).toBe(false);
    clientReq.destroy();
  });
});
