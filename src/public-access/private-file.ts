import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

/** Create or tighten a directory that contains FridayNext private runtime state. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

/** Write a secret-derived value owner-only, including when replacing a legacy 0644 file. */
export function writePrivateFile(path: string, data: string | Uint8Array): void {
  writeFileSync(path, data, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}
