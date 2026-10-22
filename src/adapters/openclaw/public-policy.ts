import { DEFAULT_ATTEST_POLICY } from "@syengup/fridaynext-channel-kit/attest/attest-gate";
import type { ProxyPathPolicy } from "@syengup/fridaynext-channel-kit/public-access/filter-proxy";

// 旧客户端的 node 与画布路径属于宿主兼容面，不进入公共库默认白名单。
export const OPENCLAW_PUBLIC_POLICY: ProxyPathPolicy = {
  allow: [/^\/friday-next(\/|$)/, /^\/friday-next-admin(\/|$)/, /^\/gateway(\/|$)/, /^\/__openclaw__(\/|$)/],
  deny: [/^\/__openclaw__\/control(\/|$)/, /^\/__openclaw__\/config(\/|$)/, /^\/__openclaw__\/api(\/|$)/, /^\/__openclaw__\/?$/],
  attest: { ...DEFAULT_ATTEST_POLICY, proxyProtectedPrefixes: ["/gateway", "/__openclaw__"], cookiePrefixes: ["/__openclaw__"] },
};
