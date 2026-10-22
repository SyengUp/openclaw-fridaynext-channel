import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
const failures = [];
if (process.argv.includes("--for-pack") && existsSync(join(root, "node_modules/.modules.yaml"))) {
  const layout = readFileSync(join(root, "node_modules/.modules.yaml"), "utf8");
  if (/["']?nodeLinker["']?:\s*["']?isolated/.test(layout) && pkg.bundledDependencies?.length)
    failures.push("隔离依赖布局不能直接打包内嵌依赖；完整离线部署请运行 pnpm package:pack");
}

if (!existsSync(join(dist, "index.js"))) failures.push("dist/index.js is missing");
if (!existsSync(join(root, "assets", "icon.png"))) failures.push("assets/icon.png is missing");

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
if (
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(
    pkg.dependencies?.["@syengup/fridaynext-channel-kit"] ?? "",
  )
) {
  failures.push("Kit 必须固定到 npm registry 的精确版本，不得使用 file、link 或 workspace 依赖");
}
if (pkg.files?.some((entry) => entry.startsWith("vendor/"))) {
  failures.push("发布包不能携带本地 vendor 依赖");
}
if (!pkg.files?.includes("assets/icon.png")) {
  failures.push("package files must include assets/icon.png");
}
if (Object.prototype.hasOwnProperty.call(manifest, "icon")) {
  failures.push("openclaw.plugin.json must not use unsupported top-level icon");
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
