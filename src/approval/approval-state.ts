import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** 使用真实网关鉴权读取审批；普通插件请求的 scope 不代表审批读取身份。 */
export async function readOpenClawApproval(id: string): Promise<Record<string, unknown> | null> {
  const cfg = object(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
  const configuredPort = object(cfg.gateway).port;
  const port = typeof configuredPort === "number" ? configuredPort : 18789;
  const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
  let result: unknown;
  try {
    // 仅调用固定的只读方法。SDK 解析本机凭证和端口，宿主校验 owner 身份；
    // 不修改请求作用域、不伪造设备身份，也不把宿主配置交给公共库。
    result = await callGatewayFromCli(
      "approval.get",
      { port: String(port), timeout: "5000", json: true },
      { id },
      {
        progress: false,
        scopes: ["operator.admin"],
        sharedStateMode: "read-only",
      },
    );
  } catch (error) {
    const details = object(object(error).details);
    if (
      details.reason === "APPROVAL_NOT_FOUND" ||
      (error instanceof Error && /^approval not found\b/i.test(error.message))
    )
      return null;
    throw error;
  }
  const approval = object(object(result).approval);
  if (
    approval.id !== id ||
    typeof approval.status !== "string" ||
    !Object.keys(object(approval.presentation)).length
  )
    throw new Error("宿主返回无效的审批状态");
  return approval;
}
