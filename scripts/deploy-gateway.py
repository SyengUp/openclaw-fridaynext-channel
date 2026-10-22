#!/usr/bin/env python3
"""本地部署入口；SSH 只执行同一份已测试的远端事务实现。"""
from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parent.parent
REMOTE_SOURCE = Path(__file__).with_name("gateway_deployment.py")


def main():
    parser = argparse.ArgumentParser(description="FridayNext 完整包部署／回滚（不发布 npm）")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--inspect", action="store_true", help="只读检查网关版本和安装位置")
    action.add_argument("--verify-only", action="store_true", help="只运行同宿主隔离验证，不停止或替换生产服务")
    action.add_argument("--rollback", metavar="BACKUP_ID", help="回滚完整代码和依赖，保留当前账本与用户数据")
    parser.add_argument("--package", type=Path, help="已验证的完整 tgz；省略时本地构建完整包")
    parser.add_argument("--sha256", help="部署前校验本地固定包 SHA-256")
    installation = parser.add_mutually_exclusive_group()
    installation.add_argument("--registry-version", help="通过 SDK 正式安装指定 npm 精确版本；仍保留完整包备份")
    installation.add_argument("--install-archive", action="store_true", help="通过 SDK 正式安装本地完整包，不发布 npm，并维护 archive 来源与回滚")
    parser.add_argument("--host", default=os.environ.get("GATEWAY_HOST", "192.144.160.181"))
    parser.add_argument("--ssh-port", type=int, default=os.environ.get("GATEWAY_SSH_PORT", "5023"), help="SSH 端口；与网关 HTTP 端口分别配置")
    parser.add_argument("--expected-sdk", default="2026.10.5", help="必须与已验证的宿主版本一致")
    parser.add_argument("--state-dir", default="~/.openclaw")
    parser.add_argument("--sdk-root", default="/opt/homebrew/lib/node_modules/openclaw")
    parser.add_argument("--node", default="/opt/homebrew/opt/node/bin/node")
    parser.add_argument("--backup-root", default="~/.openclaw-deploy-backups/friday-next")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.@:\[\]-]+", args.host) or args.host.startswith("-"):
        parser.error("SSH 目标不合法")
    if not 1 <= args.ssh_port <= 65535:
        parser.error("SSH 端口必须在 1–65535 之间")
    if args.package and (args.inspect or args.rollback):
        parser.error("检查／回滚不能同时指定新包")
    if args.registry_version and (args.inspect or args.rollback or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", args.registry_version)):
        parser.error("registry 版本必须为精确版本，且不能用于检查／回滚")
    if args.install_archive and (args.inspect or args.rollback):
        parser.error("archive 安装不能用于检查／回滚")
    # SSH 和 SCP 共用 Port 选项，上传、验证与回滚使用同一个目标入口。
    options = ["-o", "Port=" + str(args.ssh_port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]
    payload = {"state": args.state_dir, "sdk": args.sdk_root, "node": args.node, "backups": args.backup_root}
    if args.registry_version:
        payload.update(registryVersion=args.registry_version, npmSpec="@syengup/friday-channel-next@" + args.registry_version)
    if args.install_archive:
        payload["archiveInstall"] = True
    operation = "inspect" if args.inspect else "rollback" if args.rollback else "verify" if args.verify_only else "deploy"
    local_id = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    output = ROOT / ".artifacts/deploy" / local_id
    output.mkdir(parents=True, mode=0o700)
    if operation in ["deploy", "verify"]:
        package = args.package
        if package is None:
            subprocess.run(["pnpm", "package:pack", str(output)], cwd=ROOT, check=True)
            packages = list(output.glob("*.tgz"))
            if len(packages) != 1:
                raise RuntimeError("未找到唯一完整包")
            package = packages[0]
        package = package.expanduser().resolve()
        sha = hashlib.sha256(package.read_bytes()).hexdigest()
        if args.sha256 and sha != args.sha256:
            raise RuntimeError("本地包 SHA-256 与指定值不一致，未连接部署")
        remote = "/tmp/friday-next-deploy-" + local_id
        subprocess.run(["ssh", *options, args.host, "umask 077; mkdir -p " + shlex.quote(remote)], check=True)
        subprocess.run(["scp", *options, str(package), args.host + ":" + remote + "/plugin.tgz"], check=True)
        verifier = ROOT / "scripts/verify-isolated-v3.mjs"
        subprocess.run(["scp", *options, str(verifier), args.host + ":" + remote + "/verify-isolated-v3.mjs"], check=True)
        payload.update(package=remote + "/plugin.tgz", sha=sha, expectedSdk=args.expected_sdk, id=local_id)
        payload.update(verifier=remote + "/verify-isolated-v3.mjs", verifierSHA=hashlib.sha256(verifier.read_bytes()).hexdigest())
        print("完整包已上传：%s；本地 SHA-256 %s" % (package.name, sha), flush=True)
    elif operation == "rollback":
        payload["id"] = args.rollback
    def request_remote(selected):
        encoded = base64.b64encode(json.dumps(payload).encode()).decode()
        command = shlex.join(["python3", "-", selected, encoded])
        process = subprocess.run(["ssh", *options, args.host, command], input=REMOTE_SOURCE.read_text(), text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        (output / (selected + "-stderr.log")).write_text(process.stderr)
        (output / (selected + "-result.json")).write_text(process.stdout)
        if not process.stdout.strip():
            raise RuntimeError("远端未返回事务结果，查看本地 stderr.log")
        response = json.loads(process.stdout)
        if process.returncode or not response.get("ok"):
            raise RuntimeError(response.get("error", "远端事务失败"))
        return response
    if operation == "deploy":
        verified = request_remote("verify")
        print("同宿主兼容验证通过：" + verified["result"]["sdkVersion"], flush=True)
    selected = "deploy_archive" if operation == "deploy" and args.install_archive else "deploy_registry" if operation == "deploy" and args.registry_version else operation
    result = request_remote(selected)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("本地记录：" + str(output))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("错误：" + str(error), file=sys.stderr)
        sys.exit(1)
