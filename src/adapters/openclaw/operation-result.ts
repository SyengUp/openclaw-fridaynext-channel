import type { ServerResponse } from "node:http";

export interface OpenClawOperationResult {
  status: number;
  body: Record<string, unknown>;
}
export const operationResult = (
  status: number,
  body: Record<string, unknown>,
): OpenClawOperationResult => ({ status, body });
export function writeOperation(res: ServerResponse, result: OpenClawOperationResult): true {
  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result.body));
  return true;
}
