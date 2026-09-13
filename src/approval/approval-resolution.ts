import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";

// COMPAT(openclaw<=2026.7.1 approval-resolve-rpc): 将旧版统一 resolver 隔离在本地桥中，
// 便于 inbox 测试替换，也避免兼容依赖散落到业务投影。
// CLEANUP: 最低宿主版本高于 2026.7.1 后与 inbox 的 fallback 分支一起删除。
export const resolveApprovalViaGateway = resolveApprovalOverGateway;
