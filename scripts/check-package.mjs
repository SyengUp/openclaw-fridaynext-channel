import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const failures = [];

if (!existsSync(join(dist, "index.js"))) failures.push("dist/index.js is missing");

let distBytes = 0;
function inspect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      inspect(path);
      continue;
    }
    const rel = relative(root, path);
    distBytes += statSync(path).size;
    if (/ \d+\.(?:js|d\.ts)$/.test(entry.name)) failures.push(`duplicate-suffix artifact: ${rel}`);
    if (/\.test\.(?:js|d\.ts)$/.test(entry.name)) failures.push(`compiled test artifact: ${rel}`);
  }
}
if (existsSync(dist)) inspect(dist);

const forbiddenFiles = ["index.ts", "src/**", "assets/", "tsconfig.json"];
for (const entry of forbiddenFiles) {
  if (pkg.files?.includes(entry)) failures.push(`package files includes ${entry}`);
}
if (JSON.stringify(pkg.openclaw?.extensions) !== JSON.stringify(["./dist/index.js"])) {
  failures.push("openclaw.extensions must load ./dist/index.js");
}
if (distBytes > 4 * 1024 * 1024) {
  failures.push(`compiled runtime is unexpectedly large: ${distBytes} bytes`);
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`package check: ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`package check: ok (${distBytes} compiled bytes)\n`);
