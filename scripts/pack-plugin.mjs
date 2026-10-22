#!/usr/bin/env node
// 从固定 npm 依赖构建完整离线部署包；registry 发布包使用 package:registry。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const registry = args[0] === "--registry";
if (registry) args.shift();
if (args[0] === "--pack-destination") args.shift();
if (args.length > 1) throw new Error("请只指定一个输出目录");
const destination = path.resolve(
  args[0] ?? path.join(root, ".artifacts/packages", registry ? "registry" : "deployment"),
);
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-pack-"));
try {
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, ["scripts/check-package.mjs"], { cwd: root, stdio: "inherit" });
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const relative of [...metadata.files, "README.md", "API.md", "LICENSE"]) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(staging, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  // 发布包不携带开发工具；只解析生产依赖，宿主 SDK 仍由宿主提供。
  delete metadata.devDependencies;
  // 源清单保持普通 npm 依赖；只有完整部署包内嵌整条生产依赖闭包。
  if (registry) delete metadata.bundledDependencies;
  else metadata.bundledDependencies = Object.keys(metadata.dependencies ?? {});
  fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
  if (!registry)
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--registry",
        process.env.FRIDAY_NPM_REGISTRY || "https://registry.npmjs.org/",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: staging, stdio: "inherit" },
    );
  fs.mkdirSync(destination, { recursive: true });
  const output = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
      cwd: staging,
      encoding: "utf8",
    }),
  );
  process.stdout.write(path.join(destination, output[0].filename) + "\n");
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
