#!/usr/bin/env python3
"""网关完整包事务：保留安装身份，备份完整依赖与数据，失败后回滚代码。"""
from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

NAME = "@syengup/friday-channel-next"
PLUGIN_ID = "friday-next"
REQUIRED = {"durable-runtime", "idempotent-messages", "session-serial-queue", "runtime-event-replay",
            "runtime-event-ack", "canonical-events-v1", "session-metadata-v1", "service-bound-commands-v1"}


class DeploymentError(RuntimeError):
    pass


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    temporary.replace(path)


def contained(path, parent):
    try:
        Path(path).resolve().relative_to(Path(parent).resolve())
        return True
    except ValueError:
        return False


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(part)
    return value.hexdigest()


def readonly_database(path):
    database = Path(path)
    # 已关闭且无 WAL 的库使用不可变只读视图，避免旧系统 SQLite 创建旁文件或拒绝打开。
    # 活跃 WAL 必须正常读取，不能忽略其中已提交的安装记录或凭证。
    suffix = "?mode=ro" if Path(str(database) + "-wal").exists() else "?mode=ro&immutable=1"
    return sqlite3.connect(database.as_uri() + suffix, uri=True)


def extract_archive(archive_path, target, prefix, trusted_links=False):
    """兼容网关 Python 3.9；先校验全部成员和链接，再提取到私有新目录。"""
    target = Path(target)
    target.mkdir(parents=True, exist_ok=False)
    target.chmod(0o700)
    with tarfile.open(archive_path) as archive:
        members = archive.getmembers()
        if sum(member.size for member in members) > 2 * 1024 ** 3:
            raise DeploymentError("归档展开体积超过限制")
        for member in members:
            name = posixpath.normpath(member.name)
            if name != prefix and not name.startswith(prefix + "/"):
                raise DeploymentError("归档成员越过预期目录")
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise DeploymentError("归档包含不支持的成员类型")
            if member.issym() or member.islnk():
                link = member.linkname if member.islnk() else posixpath.join(posixpath.dirname(name), member.linkname)
                if not trusted_links and (posixpath.isabs(link) or not contained(target / link, target / prefix)):
                    raise DeploymentError("归档链接越过包目录")
        # 提取顺序逐项核对，防止先写的符号链接改变后续文件的落点。
        for member in members:
            if not contained(target / member.name, target):
                raise DeploymentError("归档提取路径越界")
            archive.extract(member, target)
    return target / prefix


def plugin_record(state, config):
    database = state / "state/openclaw.sqlite"
    if database.exists():
        with contextlib.closing(readonly_database(database)) as connection:
            table = connection.execute("SELECT 1 FROM sqlite_master WHERE name='config_machine_state'").fetchone()
            if table:
                row = connection.execute("SELECT value_json FROM config_machine_state WHERE state_key='plugins.installedIndex'").fetchone()
                if row:
                    index = json.loads(row[0]).get("index", {})
                    record = index.get("installRecords", {}).get(PLUGIN_ID)
                    if record:
                        return record
    record = config.get("plugins", {}).get("installs", {}).get(PLUGIN_ID)
    if not record:
        raise DeploymentError("未找到权威安装记录；禁止按目录通配选择插件")
    return record


def token_for(state, config):
    token = config.get("gateway", {}).get("auth", {}).get("token")
    if isinstance(token, dict) and token.get("id"):
        with contextlib.closing(readonly_database(state / "state/openclaw.sqlite")) as connection:
            row = connection.execute("SELECT value FROM secret_store_entries WHERE name=? AND deleted_at_ms IS NULL ORDER BY updated_at_ms DESC LIMIT 1", (token["id"],)).fetchone()
            token = row[0] if row else None
    if not isinstance(token, str) or not token:
        token = config.get("channels", {}).get(PLUGIN_ID, {}).get("authToken")
    if not isinstance(token, str) or not token:
        raise DeploymentError("无法通过只读配置解析网关凭证")
    return token


class GatewayDeployment:
    def __init__(self, state, sdk, backup_root, node, service=None, request=None, config_path=None):
        self.state, self.sdk = Path(state).expanduser().resolve(), Path(sdk).expanduser().resolve()
        self.backup_root, self.node = Path(backup_root).expanduser().resolve(), str(node)
        self.config_path = Path(config_path).resolve() if config_path else self.state / "openclaw.json"
        self.config = read_json(self.config_path)
        self.service = service or self.service_command
        self.request = request or self.http_request
        self.operation_log = None

    def locate(self):
        record = plugin_record(self.state, self.config)
        if not record.get("installPath"):
            raise DeploymentError("安装记录缺少 installPath")
        plugin = Path(record["installPath"]).expanduser().resolve()
        metadata = read_json(plugin / "package.json")
        if metadata.get("name") != NAME:
            raise DeploymentError("安装目录的包身份不匹配")
        scope = plugin
        # npm 每包独立项目连同所有祖先依赖和锁文件一起备份／回滚。
        if plugin.parent.name == "@syengup" and plugin.parent.parent.name == "node_modules":
            project = plugin.parents[2]
            project_json = project / "package.json"
            if project_json.exists() and set(read_json(project_json).get("dependencies", {})) == {NAME}:
                scope = project
        history = self.config.get("channels", {}).get(PLUGIN_ID, {}).get("historyDir")
        data = Path(history).expanduser().resolve().parent if history else self.state / "friday-next"
        if contained(self.backup_root, data) or contained(self.backup_root, scope):
            raise DeploymentError("备份目录不能位于被备份目录内部")
        return {"plugin": plugin, "scope": scope, "data": data, "record": record, "package": metadata}

    def sdk_version(self):
        return read_json(self.sdk / "package.json")["version"]

    def http_request(self, route, canonical=False):
        headers = {"Authorization": "Bearer " + token_for(self.state, self.config)}
        if canonical:
            headers["X-FridayNext-Event-Format"] = "canonical-v1"
        port = self.config.get("gateway", {}).get("port", 18789)
        with urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:%s%s" % (port, route), headers=headers), timeout=5) as response:
            if response.status != 200 or "application/json" not in response.headers.get("content-type", ""):
                raise DeploymentError("网关未返回成功 JSON")
            return json.loads(response.read())

    def service_command(self, action):
        listeners = []
        if action == "stop":
            # 托管停止命令可能先返回；备份前必须等原监听进程退出并关闭写入。
            lsof = shutil.which("lsof") or "/usr/sbin/lsof"
            probe = subprocess.run([lsof, "-t", "-iTCP:%s" % self.config.get("gateway", {}).get("port", 18789),
                                    "-sTCP:LISTEN"], capture_output=True, text=True)
            if probe.returncode not in [0, 1]:
                raise DeploymentError("无法确认停止前的网关监听进程")
            listeners = list({int(pid) for pid in probe.stdout.split()})
        environment = dict(os.environ)
        environment["OPENCLAW_STATE_DIR"] = str(self.state)
        environment["OPENCLAW_CONFIG_PATH"] = str(self.config_path)
        for name in ["OPENCLAW_SERVICE_KIND", "OPENCLAW_SERVICE_MARKER", "XPC_SERVICE_NAME"]:
            environment.pop(name, None)
        # 2026.10.5 的托管停止需要显式确认；本入口只能在获得用户部署授权后调用。
        command = [self.node, str(self.sdk / "openclaw.mjs"), "gateway", action]
        if action == "stop":
            command.append("--force")
        with self.operation_log.open("a") as stream:
            result = subprocess.run(command, env=environment,
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=90)
        if result.returncode:
            raise DeploymentError("网关服务 %s 失败，详情保存在私有 operation.log" % action)
        if action == "stop":
            deadline = time.monotonic() + 45
            while listeners:
                alive = []
                for pid in listeners:
                    try:
                        os.kill(pid, 0)
                        alive.append(pid)
                    except ProcessLookupError:
                        pass
                listeners = alive
                if listeners and time.monotonic() >= deadline:
                    raise DeploymentError("原网关尚未退出，未备份或替换插件")
                if listeners:
                    time.sleep(0.25)

    def health(self, canonical, expected_version=None, expected_identity=None, timeout=45):
        deadline = time.monotonic() + timeout
        while True:
            try:
                body = self.request("/friday-next/health", canonical)
                if body.get("ok") is not True:
                    raise DeploymentError("health.ok 非 true")
                if expected_version and body.get("pluginVersion") != expected_version:
                    raise DeploymentError("加载的插件版本不匹配")
                if canonical:
                    backend = body.get("backend", {})
                    if backend.get("id") != "openclaw" or "canonical-v1" not in backend.get("eventFormats", []):
                        raise DeploymentError("canonical 后端描述缺失")
                    if not REQUIRED.issubset(set(backend.get("capabilities", []))):
                        raise DeploymentError("通用运行能力不完整")
                if expected_identity and body.get("serverInstanceId") != expected_identity:
                    raise DeploymentError("服务账本身份发生变化")
                return {key: body.get(key) for key in ["pluginVersion", "serverInstanceId", "gatewayFingerprint", "backend", "capabilities"]}
            except Exception:
                if time.monotonic() >= deadline:
                    raise DeploymentError("部署后健康验证失败")
                time.sleep(1)

    def quiescent(self, info):
        status = self.request("/friday-next/status", False)
        runs = status.get("activeRuns", [])
        if status.get("activeRunCount", len(runs)):
            raise DeploymentError("网关仍有活跃任务，本次未停止服务")
        ledger = info["data"] / "runtime-v3/runs.jsonl"
        latest = {}
        if ledger.exists():
            for line in ledger.read_text().splitlines():
                try:
                    row = json.loads(line)
                    latest[row["runId"]] = row
                except (ValueError, KeyError):
                    continue
        if any(row.get("phase") == "queued" for row in latest.values()):
            raise DeploymentError("存在待领取命令，先等待调度完成后重试")

    def info(self):
        info = self.locate()
        health = self.health(False, timeout=0)
        return {"sdkVersion": self.sdk_version(), "pluginPath": str(info["plugin"]), "scopePath": str(info["scope"]),
                "dataPath": str(info["data"]), "pluginVersion": info["package"].get("version"), "health": health}

    def validate_package(self, package, sha, destination):
        if digest(package) != sha:
            raise DeploymentError("完整包 SHA-256 不匹配")
        staged = extract_archive(package, destination, "package")
        metadata = read_json(staged / "package.json")
        if metadata.get("name") != NAME or not (staged / "dist/index.js").is_file():
            raise DeploymentError("完整包身份或入口不正确")
        if not set(metadata.get("dependencies", {})).issubset(set(metadata.get("bundledDependencies", []))):
            raise DeploymentError("生产依赖没有全部内嵌")
        for name in metadata.get("dependencies", {}):
            if not (staged / "node_modules" / name / "package.json").is_file():
                raise DeploymentError("内嵌生产依赖缺失：" + name)
        if (staged / "node_modules/openclaw").exists():
            raise DeploymentError("部署包不能携带或覆盖宿主 SDK")
        peer = staged / "node_modules/openclaw"
        peer.symlink_to(self.sdk)
        return staged, metadata

    def verify(self, package, sha, expected_sdk, verifier, verifier_sha, npm_spec=None, archive_install=False):
        if self.sdk_version() != expected_sdk:
            raise DeploymentError("宿主 SDK 与指定兼容版本不一致")
        if digest(verifier) != verifier_sha:
            raise DeploymentError("隔离验证脚本完整性不匹配")
        root = Path(tempfile.mkdtemp(prefix="friday-package-compat-"))
        staged, metadata = self.validate_package(package, sha, root / "incoming")
        environment = dict(os.environ)
        environment["OPENCLAW_PACKAGE_ROOT"] = str(self.sdk)
        environment["FRIDAY_TEST_PLUGIN_ROOT"] = str(staged)
        environment.pop("FRIDAY_TEST_NPM_SPEC", None)
        environment.pop("FRIDAY_TEST_ARCHIVE_PATH", None)
        if archive_install:
            if npm_spec:
                raise DeploymentError("archive 与 registry 安装模式不能同时使用")
            environment["FRIDAY_TEST_ARCHIVE_PATH"] = str(package)
        if npm_spec:
            if npm_spec != NAME + "@" + metadata["version"]:
                raise DeploymentError("registry 版本与完整部署包不一致")
            environment["FRIDAY_TEST_NPM_SPEC"] = npm_spec
        log = root / "verify.log"
        with log.open("w") as stream:
            result = subprocess.run([self.node, str(verifier)], cwd=root, env=environment,
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=420 if npm_spec or archive_install else 150)
        if result.returncode:
            raise DeploymentError("隔离 SDK 兼容验证失败，详情：" + str(log))
        match = re.search(r"真实 OpenClaw 隔离验证通过：([^\r\n]+)", log.read_text())
        if not match:
            raise DeploymentError("隔离验证未给出成功回执")
        report = read_json(Path(match.group(1)) / "report.json")
        if report.get("sdk") != expected_sdk or report.get("modelCalls") is not False:
            raise DeploymentError("隔离验证结果与部署条件不一致")
        if npm_spec and report.get("npmInstallation", {}).get("spec") != npm_spec:
            raise DeploymentError("未取得 SDK 原生 npm 安装回执")
        if archive_install and report.get("archiveInstallation", {}).get("source") != "archive":
            raise DeploymentError("未取得 SDK 原生 archive 安装回执")
        return {"sdkVersion": expected_sdk, "artifactSHA256": sha, "pluginVersion": metadata["version"],
                "npmInstallation": report.get("npmInstallation"),
                "archiveInstallation": report.get("archiveInstallation"),
                "directory": str(root), "testState": match.group(1), "checks": report["passed"], "modelCalls": False}

    @contextlib.contextmanager
    def locked(self):
        self.backup_root.mkdir(parents=True, exist_ok=True)
        self.backup_root.chmod(0o700)
        with (self.backup_root / ".lock").open("a") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeploymentError("已有部署／回滚事务运行中")
            yield

    def archive(self, source, destination, prefix):
        with tarfile.open(destination, "w:gz", dereference=False) as stream:
            stream.add(source, arcname=prefix)
        Path(destination).chmod(0o600)

    def snapshot(self, info, backup):
        self.archive(info["scope"], backup / "code.tgz", "scope")
        if info["data"].exists():
            self.archive(info["data"], backup / "data.tgz", "data")
        shutil.copy2(self.config_path, backup / "openclaw.json")
        (backup / "openclaw.json").chmod(0o600)
        database = self.state / "state/openclaw.sqlite"
        if database.exists():
            with contextlib.closing(readonly_database(database)) as source:
                with contextlib.closing(sqlite3.connect(str(backup / "openclaw.sqlite"))) as target:
                    source.backup(target)
            (backup / "openclaw.sqlite").chmod(0o600)
        names = ["code.tgz", "data.tgz", "openclaw.json", "openclaw.sqlite"]
        for database in sorted((self.state / "agents").glob("*/agent/openclaw-agent.sqlite")):
            relative = "agents/" + database.parent.parent.name + "/openclaw-agent.sqlite"
            destination = backup / relative
            destination.parent.mkdir(parents=True, mode=0o700)
            with contextlib.closing(readonly_database(database)) as source:
                with contextlib.closing(sqlite3.connect(str(destination))) as target:
                    source.backup(target)
            destination.chmod(0o600)
            names.append(relative)
        return {name: digest(backup / name) for name in names if (backup / name).exists()}

    def install_command(self, target):
        """使用宿主正式安装事务维护来源和版本；不直接写 SDK 安装索引。"""
        environment = dict(os.environ)
        environment.update(OPENCLAW_STATE_DIR=str(self.state), OPENCLAW_CONFIG_PATH=str(self.config_path),
                           PATH=str(Path(self.node).parent) + os.pathsep + environment.get("PATH", ""))
        for name in ["OPENCLAW_SERVICE_KIND", "OPENCLAW_SERVICE_MARKER", "XPC_SERVICE_NAME"]:
            environment.pop(name, None)
        anonymous = self.operation_log.parent / "anonymous.npmrc"
        anonymous.write_text("registry=https://registry.npmjs.org/\n")
        anonymous.chmod(0o600)
        environment.update(NPM_CONFIG_USERCONFIG=str(anonymous), NPM_CONFIG_GLOBALCONFIG="/dev/null",
                           NPM_CONFIG_CACHE=str(self.operation_log.parent / "npm-cache"))
        # 部署前已比对声明面；仅接受已授权插件的同一组能力。
        command = [self.node, str(self.sdk / "openclaw.mjs"), "plugins", "install", str(target), "--force", "--no-enable", "--accept-capabilities"]
        if str(target).startswith(NAME + "@"):
            command.append("--pin")
        with self.operation_log.open("a") as stream:
            result = subprocess.run(command, env=environment, stdout=stream, stderr=subprocess.STDOUT, timeout=300)
        if result.returncode:
            raise DeploymentError("SDK 安装失败，详情保存在私有 operation.log")
        self.config = read_json(self.config_path)

    def rollback_package(self, info, backup):
        """保存实际运行代码和提升到项目级的依赖，不依赖旧版本仍在 registry。"""
        staging = backup / "rollback-staging"
        package = staging / "package"
        def ignore(directory, names):
            return [name for name in names if Path(directory).name == "node_modules" and name in ["openclaw", ".bin", ".package-lock.json"]]
        shutil.copytree(info["plugin"], package, symlinks=True, ignore=ignore)
        modules = package / "node_modules"
        modules.mkdir(exist_ok=True)
        ancestors = info["scope"] / "node_modules"
        def copy_dependency(source, destination):
            if source.resolve() == info["plugin"] or destination.exists() or destination.is_symlink():
                return
            if source.is_dir():
                shutil.copytree(source, destination, symlinks=True, ignore=ignore)
            else:
                shutil.copy2(source, destination, follow_symlinks=False)
        if ancestors.is_dir() and info["scope"] != info["plugin"]:
            for source in ancestors.iterdir():
                if source.name.startswith(".") or source.name == "openclaw":
                    continue
                if source.name.startswith("@") and source.is_dir():
                    (modules / source.name).mkdir(exist_ok=True)
                    for dependency in source.iterdir():
                        copy_dependency(dependency, modules / source.name / dependency.name)
                else:
                    copy_dependency(source, modules / source.name)
        metadata = read_json(package / "package.json")
        metadata["bundledDependencies"] = list(metadata.get("dependencies", {}))
        write_json(package / "package.json", metadata)
        target = backup / "rollback-package.tgz"
        self.archive(package, target, "package")
        shutil.rmtree(staging)
        return digest(target)

    def deploy_registry(self, package, sha, expected_sdk, operation_id, version, health_timeout=45):
        return self._deploy_installed(package, sha, expected_sdk, operation_id, version, False, health_timeout)

    def deploy_archive(self, package, sha, expected_sdk, operation_id, health_timeout=45):
        return self._deploy_installed(package, sha, expected_sdk, operation_id, None, True, health_timeout)

    def _deploy_installed(self, package, sha, expected_sdk, operation_id, version, archive_install, health_timeout):
        if (version is not None and not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version)) or not re.fullmatch(r"[A-Za-z0-9_-]+", operation_id):
            raise DeploymentError("版本或部署标识不合法")
        with self.locked():
            if self.sdk_version() != expected_sdk:
                raise DeploymentError("宿主 SDK 与已验证版本不一致")
            info = self.locate()
            before = self.health(False, timeout=0)
            self.quiescent(info)
            backup = self.backup_root / operation_id
            backup.mkdir(mode=0o700)
            self.operation_log = backup / "operation.log"
            shutil.copy2(package, backup / "package.tgz")
            (backup / "package.tgz").chmod(0o600)
            staged, metadata = self.validate_package(backup / "package.tgz", sha, backup / "incoming")
            if version is None:
                version = metadata["version"]
            if metadata["version"] != version or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version) or read_json(staged / "openclaw.plugin.json") != read_json(info["plugin"] / "openclaw.plugin.json"):
                raise DeploymentError("版本或插件声明面不一致")
            manifest = {"id": operation_id, "mode": "archive" if archive_install else "registry", "status": "prepared", "sdkVersion": expected_sdk,
                        "artifactSHA256": sha, "beforeHealth": before,
                        "beforeVersion": info["package"]["version"], "afterVersion": version,
                        "pluginPath": str(info["plugin"]), "scopePath": str(info["scope"]), "dataPath": str(info["data"]),
                        "installRecord": info["record"], "rollbackPreservesCurrentData": True}
            target = str(backup / "package.tgz") if archive_install else NAME + "@" + version
            manifest["archivePath" if archive_install else "registrySpec"] = target
            write_json(backup / "manifest.json", manifest)
            attempted = False
            try:
                self.service("stop")
                manifest["snapshots"] = self.snapshot(info, backup)
                manifest["rollbackPackageSHA256"] = self.rollback_package(info, backup)
                write_json(backup / "manifest.json", manifest)
                attempted = True
                self.install_command(target)
                installed = self.locate()
                if installed["record"].get("source") != ("archive" if archive_install else "npm") or (not archive_install and installed["record"].get("spec") != target) or installed["package"].get("version") != version:
                    raise DeploymentError("SDK 安装记录未固定到目标版本")
                self.service("start")
                after = self.health(True, version, before.get("serverInstanceId"), health_timeout)
                if before.get("gatewayFingerprint") != after.get("gatewayFingerprint"):
                    raise DeploymentError("网关指纹发生变化")
                manifest.update(status="deployed", afterHealth=after, afterInstallRecord=installed["record"])
                write_json(backup / "manifest.json", manifest)
                return manifest
            except BaseException as error:
                manifest["failure"] = type(error).__name__ + ": " + str(error)
                try:
                    if attempted:
                        self.service("stop")
                        try:
                            self.restore_registry(manifest, backup)
                        finally:
                            self.service("start")
                    else:
                        self.service("start")
                    self.health(False, manifest["beforeVersion"], before.get("serverInstanceId"), health_timeout)
                    manifest["status"] = "rolled_back"
                except BaseException as rollback_error:
                    manifest.update(status="rollback_failed", rollbackFailure=type(rollback_error).__name__)
                write_json(backup / "manifest.json", manifest)
                raise DeploymentError("SDK 部署失败；事务状态 %s，备份 %s" % (manifest["status"], backup)) from error

    def restore_registry(self, manifest, backup):
        target = backup / "rollback-package.tgz"
        if digest(target) != manifest.get("rollbackPackageSHA256"):
            raise DeploymentError("回滚完整包 SHA-256 不匹配")
        self.install_command(target)

    def restore_code(self, manifest, backup):
        if digest(backup / "code.tgz") != manifest.get("snapshots", {}).get("code.tgz"):
            raise DeploymentError("代码备份 SHA-256 不匹配")
        scope = Path(manifest["scopePath"])
        parent = Path(tempfile.mkdtemp(prefix=".friday-restore-", dir=str(scope.parent)))
        parent.rmdir()
        restored = extract_archive(backup / "code.tgz", parent, "scope", trusted_links=True)
        failed = scope.with_name(".friday-replaced-" + str(time.time_ns()))
        if scope.exists():
            scope.rename(failed)
        try:
            restored.rename(scope)
        except BaseException:
            if failed.exists() and not scope.exists():
                failed.rename(scope)
            raise
        finally:
            if parent.exists():
                shutil.rmtree(parent)
        if failed.exists():
            shutil.move(str(failed), str(backup / failed.name))

    def deploy(self, package, sha, expected_sdk, operation_id, health_timeout=45):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", operation_id):
            raise DeploymentError("部署标识不合法")
        with self.locked():
            if self.sdk_version() != expected_sdk:
                raise DeploymentError("网关 SDK 与兼容验证版本不一致")
            info = self.locate()
            before = self.health(False, timeout=0)
            self.quiescent(info)
            backup = self.backup_root / operation_id
            backup.mkdir(mode=0o700)
            self.operation_log = backup / "operation.log"
            retained = backup / "package.tgz"
            shutil.copy2(package, retained)
            retained.chmod(0o600)
            staged, metadata = self.validate_package(retained, sha, backup / "incoming")
            # 同一包身份、同一已接受的声明面；不写 SDK 安装记录或新增第二来源。
            for name in ["openclaw.plugin.json"]:
                if read_json(info["plugin"] / name) != read_json(staged / name):
                    raise DeploymentError("插件声明面变化，需要先通过 SDK 正式安装流程接受")
            manifest = {"id": operation_id, "status": "prepared", "artifactSHA256": sha, "sdkVersion": expected_sdk,
                        "pluginPath": str(info["plugin"]), "scopePath": str(info["scope"]), "dataPath": str(info["data"]),
                        "beforeVersion": info["package"].get("version"), "afterVersion": metadata.get("version"),
                        "beforeHealth": before, "installRecord": info["record"], "rollbackPreservesCurrentData": True}
            write_json(backup / "manifest.json", manifest)
            switched = False
            try:
                self.service("stop")
                manifest["snapshots"] = self.snapshot(info, backup)
                write_json(backup / "manifest.json", manifest)
                sibling = Path(tempfile.mkdtemp(prefix=".friday-incoming-", dir=str(info["plugin"].parent)))
                shutil.copytree(staged, sibling / "package", symlinks=True)
                retired = sibling / "retired-package"
                info["plugin"].rename(retired)
                try:
                    (sibling / "package").rename(info["plugin"])
                    switched = True
                except BaseException:
                    retired.rename(info["plugin"])
                    raise
                if retired.exists():
                    shutil.move(str(retired), str(backup / "retired-package"))
                shutil.rmtree(sibling)
                self.service("start")
                after = self.health(True, metadata.get("version"), before.get("serverInstanceId"), health_timeout)
                if before.get("gatewayFingerprint") and before["gatewayFingerprint"] != after.get("gatewayFingerprint"):
                    raise DeploymentError("网关长期指纹发生变化")
                manifest.update(status="deployed", afterHealth=after)
                write_json(backup / "manifest.json", manifest)
                return manifest
            except BaseException as error:
                manifest["failure"] = type(error).__name__ + ": " + str(error)
                try:
                    if switched:
                        self.service("stop")
                        self.restore_code(manifest, backup)
                    self.service("start")
                    self.health(False, manifest["beforeVersion"], timeout=health_timeout)
                    manifest["status"] = "rolled_back"
                except BaseException as rollback_error:
                    manifest["status"] = "rollback_failed"
                    manifest["rollbackFailure"] = type(rollback_error).__name__
                write_json(backup / "manifest.json", manifest)
                raise DeploymentError("部署失败；事务状态 %s，备份 %s" % (manifest["status"], backup)) from error

    def rollback(self, operation_id, health_timeout=45):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", operation_id):
            raise DeploymentError("备份标识不合法")
        with self.locked():
            backup = self.backup_root / operation_id
            manifest = read_json(backup / "manifest.json")
            info = self.locate()
            if manifest.get("mode") in ["registry", "archive"]:
                if self.sdk_version() != manifest["sdkVersion"]:
                    raise DeploymentError("宿主 SDK 已变化，先重新验证兼容性")
                if digest(backup / "rollback-package.tgz") != manifest.get("rollbackPackageSHA256"):
                    raise DeploymentError("回滚完整包 SHA-256 不匹配")
                self.quiescent(info)
                self.operation_log = backup / "operation.log"
                self.service("stop")
                try:
                    self.restore_registry(manifest, backup)
                finally:
                    self.service("start")
                after = self.health(False, manifest["beforeVersion"], manifest["beforeHealth"].get("serverInstanceId"), health_timeout)
                manifest.update(status="rolled_back", rollbackHealth=after, rollbackInstallRecord=self.locate()["record"])
                write_json(backup / "manifest.json", manifest)
                return manifest
            if str(info["plugin"]) != manifest["pluginPath"] or str(info["scope"]) != manifest["scopePath"]:
                raise DeploymentError("当前安装位置已变化，禁止套用旧快照")
            if self.sdk_version() != manifest["sdkVersion"]:
                raise DeploymentError("宿主 SDK 已变化，先重新验证兼容性")
            if digest(backup / "code.tgz") != manifest.get("snapshots", {}).get("code.tgz"):
                raise DeploymentError("代码备份 SHA-256 不匹配")
            self.quiescent(info)
            self.operation_log = backup / "operation.log"
            self.service("stop")
            self.restore_code(manifest, backup)
            self.service("start")
            after = self.health(False, manifest["beforeVersion"], timeout=health_timeout)
            manifest.update(status="rolled_back", rollbackHealth=after)
            write_json(backup / "manifest.json", manifest)
            return manifest


def remote_main():
    action = sys.argv[1]
    args = json.loads(base64.b64decode(sys.argv[2]))
    manager = GatewayDeployment(args["state"], args["sdk"], args["backups"], args["node"])
    if action == "inspect":
        result = manager.info()
    elif action == "verify":
        result = manager.verify(args["package"], args["sha"], args["expectedSdk"], args["verifier"], args["verifierSHA"], args.get("npmSpec"), args.get("archiveInstall", False))
    elif action == "deploy":
        result = manager.deploy(args["package"], args["sha"], args["expectedSdk"], args["id"])
    elif action == "rollback":
        result = manager.rollback(args["id"])
    elif action == "deploy_registry":
        result = manager.deploy_registry(args["package"], args["sha"], args["expectedSdk"], args["id"], args["registryVersion"])
    elif action == "deploy_archive":
        result = manager.deploy_archive(args["package"], args["sha"], args["expectedSdk"], args["id"])
    else:
        raise DeploymentError("未知远端操作")
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        remote_main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
