"""完整包部署故障台架，不连接 SSH、不启动生产网关。"""
import importlib.util
import io
import json
import shlex
import shutil
import sqlite3
import subprocess
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gateway_deployment", Path(__file__).with_name("gateway_deployment.py"))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class FullPackageDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="friday-deploy-contract-")
        self.root = Path(self.temporary.name)
        self.state, self.sdk, self.backups = self.root / "state", self.root / "sdk", self.root / "backups"
        self.sdk.mkdir()
        (self.sdk / "package.json").write_text(json.dumps({"version": "2026.10.5"}))
        self.project = self.state / "npm/projects/friday-current"
        self.plugin = self.project / "node_modules/@syengup/friday-channel-next"
        self.plugin.mkdir(parents=True)
        self.old_metadata = {"name": deployment.NAME, "version": "old", "dependencies": {}}
        (self.plugin / "package.json").write_text(json.dumps(self.old_metadata))
        (self.plugin / "dist").mkdir()
        (self.plugin / "dist/index.js").write_text("原插件代码")
        self.surface = {"id": "friday-next", "channels": ["friday-next"]}
        (self.plugin / "openclaw.plugin.json").write_text(json.dumps(self.surface))
        (self.project / "package.json").write_text(json.dumps({"dependencies": {deployment.NAME: "old"}}))
        (self.project / "node_modules/old-parent-dependency.txt").write_text("原依赖")
        config = {"gateway": {"auth": {"token": "fixture"}}, "plugins": {"installs": {"friday-next": {"source": "npm", "installPath": str(self.plugin)}}}}
        (self.state / "openclaw.json").write_text(json.dumps(config))
        self.data = self.state / "friday-next"
        self.data.mkdir()
        (self.data / "identity.json").write_text('{"profile":"AbC","tls":"保持原值"}')
        self.calls = []
        self.fail_new = False
        self.manager = deployment.GatewayDeployment(self.state, self.sdk, self.backups, "/fixture/node", service=self.calls.append, request=self.request)

    def tearDown(self):
        self.temporary.cleanup()

    def request(self, route, canonical):
        if route.endswith("status"):
            return {"activeRuns": [], "activeRunCount": 0}
        installed = self.manager.locate()["plugin"]
        version = json.loads((installed / "package.json").read_text())["version"]
        body = {"ok": True, "pluginVersion": version, "serverInstanceId": "stable/AbC", "gatewayFingerprint": "tls/AbC"}
        if not (self.fail_new and version != "old"):
            body["backend"] = {"id": "openclaw", "eventFormats": ["canonical-v1"], "capabilities": list(deployment.REQUIRED)}
        return body

    def package(self, missing=False, version="new"):
        root = self.root / "payload"
        root.mkdir()
        metadata = {"name": deployment.NAME, "version": version, "dependencies": {"@syengup/fridaynext-channel-kit": "0.1.2", "qrcode-terminal": "0.12.0"}, "bundledDependencies": ["@syengup/fridaynext-channel-kit", "qrcode-terminal"]}
        (root / "package.json").write_text(json.dumps(metadata))
        (root / "openclaw.plugin.json").write_text(json.dumps(self.surface))
        (root / "dist").mkdir()
        (root / "dist/index.js").write_text("新插件代码")
        for name in metadata["dependencies"]:
            if missing and name == "qrcode-terminal":
                continue
            directory = root / "node_modules" / name
            directory.mkdir(parents=True)
            (directory / "package.json").write_text(json.dumps({"name": name, "version": metadata["dependencies"][name]}))
        archive = self.root / "plugin.tgz"
        with tarfile.open(archive, "w:gz") as stream:
            stream.add(root, arcname="package")
        return archive

    def deploy(self):
        archive = self.package()
        return self.manager.deploy(archive, deployment.digest(archive), "2026.10.5", "fixture-release", health_timeout=0)

    def test_full_install_keeps_data_and_backs_up_parent_dependencies(self):
        before = (self.data / "identity.json").read_bytes()
        result = self.deploy()
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(self.calls, ["stop", "start"])
        self.assertTrue((self.plugin / "node_modules/@syengup/fridaynext-channel-kit/package.json").exists())
        self.assertEqual((self.data / "identity.json").read_bytes(), before)
        backup = self.backups / "fixture-release"
        self.assertEqual(deployment.digest(backup / "package.tgz"), result["artifactSHA256"])
        with tarfile.open(backup / "code.tgz") as archive:
            self.assertIn("scope/node_modules/old-parent-dependency.txt", archive.getnames())
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)

    def test_health_failure_restores_old_code_automatically(self):
        self.fail_new = True
        with self.assertRaises(deployment.DeploymentError):
            self.deploy()
        self.assertEqual(json.loads((self.plugin / "package.json").read_text())["version"], "old")
        self.assertEqual(self.calls, ["stop", "start", "stop", "start"])
        self.assertEqual(json.loads((self.backups / "fixture-release/manifest.json").read_text())["status"], "rolled_back")

    def test_manual_rollback_restores_full_project_and_preserves_new_runtime_data(self):
        self.deploy()
        (self.project / "node_modules/old-parent-dependency.txt").write_text("改变的依赖")
        (self.data / "new-request.json").write_text('{"requestId":"new/AbC"}')
        self.manager.rollback("fixture-release", health_timeout=0)
        self.assertEqual((self.project / "node_modules/old-parent-dependency.txt").read_text(), "原依赖")
        self.assertTrue((self.data / "new-request.json").exists())

    def test_corrupt_payload_stops_before_gateway_actions(self):
        archive = self.package()
        with self.assertRaises(deployment.DeploymentError):
            self.manager.deploy(archive, "0" * 64, "2026.10.5", "bad", health_timeout=0)
        self.assertEqual(self.calls, [])

    def test_missing_runtime_dependency_stops_before_gateway_actions(self):
        archive = self.package(missing=True)
        with self.assertRaises(deployment.DeploymentError):
            self.manager.deploy(archive, deployment.digest(archive), "2026.10.5", "bad", health_timeout=0)
        self.assertEqual(self.calls, [])

    def test_unverified_sdk_does_not_stop_gateway(self):
        archive = self.package()
        with self.assertRaises(deployment.DeploymentError):
            self.manager.deploy(archive, deployment.digest(archive), "2026.10.1", "bad", health_timeout=0)
        self.assertEqual(self.calls, [])

    def test_active_run_does_not_stop_gateway(self):
        original = self.manager.request
        self.manager.request = lambda route, canonical: {"activeRunCount": 1} if route.endswith("status") else original(route, canonical)
        with self.assertRaises(deployment.DeploymentError):
            self.deploy()
        self.assertEqual(self.calls, [])

    def test_queued_command_does_not_stop_gateway(self):
        ledger = self.data / "runtime-v3/runs.jsonl"
        ledger.parent.mkdir()
        ledger.write_text(json.dumps({"runId": "pending/AbC", "phase": "queued"}) + "\n")
        with self.assertRaises(deployment.DeploymentError):
            self.deploy()
        self.assertEqual(self.calls, [])

    def test_installed_index_takes_priority_over_legacy_config(self):
        database = self.state / "state/openclaw.sqlite"
        database.parent.mkdir()
        with sqlite3.connect(database) as connection:
            connection.execute("CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT)")
            connection.execute("INSERT INTO config_machine_state VALUES (?, ?)", ("plugins.installedIndex", json.dumps({"index": {"installRecords": {"friday-next": {"source": "npm", "installPath": str(self.plugin)}}}})))
        self.manager.config["plugins"]["installs"]["friday-next"]["installPath"] = str(self.root / "wrong-copy")
        result = self.deploy()
        self.assertEqual(result["pluginPath"], str(self.plugin.resolve()))
        self.assertIn("openclaw.sqlite", result["snapshots"])

    def test_closed_wal_index_read_does_not_create_sidecars(self):
        database = self.state / "state/openclaw.sqlite"
        database.parent.mkdir()
        seed = database.with_name("closed-seed.sqlite")
        with sqlite3.connect(seed) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT)")
            connection.execute("INSERT INTO config_machine_state VALUES (?, ?)", ("plugins.installedIndex", json.dumps({"index": {"installRecords": {"friday-next": {"installPath": str(self.plugin)}}}})))
            connection.commit()
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        connection.close()
        shutil.copy2(seed, database)
        self.assertFalse(Path(str(database) + "-wal").exists())
        self.assertEqual(deployment.plugin_record(self.state, self.manager.config)["installPath"], str(self.plugin))
        self.assertFalse(Path(str(database) + "-wal").exists())
        self.assertFalse(Path(str(database) + "-shm").exists())

    def test_active_wal_index_reads_committed_records_from_wal(self):
        database = self.state / "state/openclaw.sqlite"
        database.parent.mkdir()
        connection = sqlite3.connect(database)
        try:
            connection.execute("CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT)")
            connection.commit()
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("INSERT INTO config_machine_state VALUES (?, ?)", ("plugins.installedIndex", json.dumps({"index": {"installRecords": {"friday-next": {"installPath": str(self.plugin)}}}})))
            connection.commit()
            self.assertTrue(Path(str(database) + "-wal").exists())
            self.assertEqual(deployment.plugin_record(self.state, self.manager.config)["installPath"], str(self.plugin))
        finally:
            connection.close()

    def test_changed_declaration_surface_does_not_stop_gateway(self):
        self.surface["contracts"] = {"newPrivilege": True}
        with self.assertRaises(deployment.DeploymentError):
            self.deploy()
        self.assertEqual(self.calls, [])

    def test_failed_start_restores_previous_service(self):
        def service(action):
            self.calls.append(action)
            if self.calls == ["stop", "start"]:
                raise RuntimeError("故障注入：新服务启动失败")
        self.manager.service = service
        with self.assertRaises(deployment.DeploymentError):
            self.deploy()
        self.assertEqual(self.calls, ["stop", "start", "stop", "start"])
        self.assertEqual(json.loads((self.plugin / "package.json").read_text())["version"], "old")

    def test_service_identity_change_rolls_back(self):
        original = self.manager.request
        def changed_identity(route, canonical):
            result = original(route, canonical)
            if canonical and result.get("pluginVersion") == "new":
                result["serverInstanceId"] = "changed"
            return result
        self.manager.request = changed_identity
        with self.assertRaises(deployment.DeploymentError):
            self.deploy()
        self.assertEqual(json.loads((self.plugin / "package.json").read_text())["version"], "old")

    def test_redeployment_backup_can_restore_external_sdk_peer_link(self):
        self.deploy()
        archive = self.root / "plugin.tgz"
        self.manager.deploy(archive, deployment.digest(archive), "2026.10.5", "second-release", health_timeout=0)
        self.manager.rollback("second-release", health_timeout=0)
        self.assertTrue((self.plugin / "node_modules/openclaw").is_symlink())
        self.assertEqual((self.plugin / "node_modules/openclaw").resolve(), self.sdk.resolve())

    def test_changed_install_path_blocks_manual_rollback(self):
        self.deploy()
        self.calls.clear()
        self.manager.config["plugins"]["installs"]["friday-next"]["installPath"] = str(self.root / "new-location")
        with self.assertRaises((deployment.DeploymentError, FileNotFoundError)):
            self.manager.rollback("fixture-release", health_timeout=0)
        self.assertEqual(self.calls, [])

    def test_frontend_never_deploys_after_failed_compatibility(self):
        entry_spec = importlib.util.spec_from_file_location("deploy_gateway_entry", Path(__file__).with_name("deploy-gateway.py"))
        entry = importlib.util.module_from_spec(entry_spec)
        entry_spec.loader.exec_module(entry)
        archive = self.package()
        scripts = self.root / "scripts"
        scripts.mkdir()
        (scripts / "verify-isolated-v3.mjs").write_text("测试验证器")
        actions = []
        def run(command, **kwargs):
            if "input" in kwargs:
                selected = shlex.split(command[-1])[2]
                actions.append(selected)
                return subprocess.CompletedProcess(command, 1, json.dumps({"ok": False, "error": "兼容性故障"}), "")
            return subprocess.CompletedProcess(command, 0, "", "")
        with patch.object(entry, "ROOT", self.root), patch.object(entry.subprocess, "run", side_effect=run), patch("sys.argv", ["deploy-gateway.py", "--package", str(archive)]):
            with self.assertRaisesRegex(RuntimeError, "兼容性故障"):
                entry.main()
        self.assertEqual(actions, ["verify"])

    def test_managed_stop_waits_until_listener_process_exits(self):
        self.manager.operation_log = self.root / "operation.log"
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, "12345\n" if "-sTCP:LISTEN" in command else "", "")
        with patch.object(deployment.subprocess, "run", side_effect=run), patch.object(deployment.os, "kill", side_effect=ProcessLookupError) as probe:
            self.manager.service_command("stop")
        probe.assert_called_once_with(12345, 0)
        self.assertEqual(commands[-1][-3:], ["gateway", "stop", "--force"])

    def test_still_running_process_blocks_code_snapshot(self):
        self.manager.operation_log = self.root / "operation.log"
        def run(command, **kwargs):
            return subprocess.CompletedProcess(command, 0, "12345\n" if "-sTCP:LISTEN" in command else "", "")
        with patch.object(deployment.subprocess, "run", side_effect=run), patch.object(deployment.os, "kill"), patch.object(deployment.time, "monotonic", side_effect=[0, 46]):
            with self.assertRaisesRegex(deployment.DeploymentError, "原网关尚未退出"):
                self.manager.service_command("stop")

    def test_traversal_archive_cannot_write_outside_staging(self):
        archive = self.root / "malicious.tgz"
        with tarfile.open(archive, "w:gz") as stream:
            member = tarfile.TarInfo("../outside")
            member.size = 1
            stream.addfile(member, io.BytesIO(b"x"))
        with self.assertRaises(deployment.DeploymentError):
            deployment.extract_archive(archive, self.root / "extracted", "package")
        self.assertFalse((self.root / "outside").exists())

    def test_tampered_backup_is_rejected_before_gateway_stop(self):
        self.deploy()
        self.calls.clear()
        with (self.backups / "fixture-release/code.tgz").open("ab") as stream:
            stream.write("被修改的备份".encode())
        with self.assertRaises(deployment.DeploymentError):
            self.manager.rollback("fixture-release", health_timeout=0)
        self.assertEqual(self.calls, [])

    def prepare_registry(self):
        self.registry_archive = self.package(version="2026.10.4-beta.1")
        self.registry_installs = []
        def install(target):
            self.registry_installs.append(str(target))
            archive = self.registry_archive if str(target).startswith(deployment.NAME + "@") else Path(target)
            parent = Path(tempfile.mkdtemp(dir=self.root))
            parent.rmdir()
            extracted = deployment.extract_archive(archive, parent, "package")
            project = self.state / "npm/projects" / ("sdk-generation-" + str(len(self.registry_installs)))
            installed = project / "node_modules/@syengup/friday-channel-next"
            installed.parent.mkdir(parents=True)
            shutil.move(str(extracted), str(installed))
            version = json.loads((installed / "package.json").read_text())["version"]
            (project / "package.json").write_text(json.dumps({"dependencies": {deployment.NAME: version}}))
            npm_source = str(target).startswith(deployment.NAME + "@")
            self.manager.config["plugins"]["installs"]["friday-next"].update(source="npm" if npm_source else "archive", spec=deployment.NAME + "@" + version if npm_source else str(target), installPath=str(installed))
            (self.state / "openclaw.json").write_text(json.dumps(self.manager.config))
        self.manager.install_command = install

    def registry_deploy(self):
        return self.manager.deploy_registry(self.registry_archive, deployment.digest(self.registry_archive), "2026.10.5", "registry-release", "2026.10.4-beta.1", health_timeout=0)

    def test_registry_update_tracks_sdk_generation_and_full_rollback_package(self):
        self.prepare_registry()
        (self.project / "node_modules/openclaw").symlink_to(self.sdk)
        result = self.registry_deploy()
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(self.registry_installs, [deployment.NAME + "@2026.10.4-beta.1"])
        self.assertNotEqual(result["afterInstallRecord"]["installPath"], result["pluginPath"])
        with tarfile.open(self.backups / "registry-release/rollback-package.tgz") as archive:
            self.assertIn("package/node_modules/old-parent-dependency.txt", archive.getnames())
            self.assertNotIn("package/node_modules/openclaw", archive.getnames())

    def test_registry_failed_health_reinstalls_backup_through_sdk(self):
        self.prepare_registry()
        self.fail_new = True
        with self.assertRaises(deployment.DeploymentError):
            self.registry_deploy()
        self.assertEqual(self.calls, ["stop", "start", "stop", "start"])
        self.assertEqual(len(self.registry_installs), 2)
        self.assertEqual(json.loads((self.backups / "registry-release/manifest.json").read_text())["status"], "rolled_back")
        self.assertEqual(self.manager.health(False, timeout=0)["pluginVersion"], "old")

    def test_registry_manual_rollback_handles_changed_path_and_keeps_new_requests(self):
        self.prepare_registry()
        self.registry_deploy()
        (self.data / "new-request.json").write_text('{"requestId":"new/AbC"}')
        result = self.manager.rollback("registry-release", health_timeout=0)
        self.assertEqual(result["status"], "rolled_back")
        self.assertEqual(result["rollbackHealth"]["pluginVersion"], "old")
        self.assertTrue((self.data / "new-request.json").exists())

    def test_registry_rollback_hash_failure_does_not_stop_gateway(self):
        self.prepare_registry()
        self.registry_deploy()
        self.calls.clear()
        with (self.backups / "registry-release/rollback-package.tgz").open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaises(deployment.DeploymentError):
            self.manager.rollback("registry-release", health_timeout=0)
        self.assertEqual(self.calls, [])

    def test_registry_version_mismatch_does_not_stop_gateway(self):
        self.prepare_registry()
        with self.assertRaises(deployment.DeploymentError):
            self.manager.deploy_registry(self.registry_archive, deployment.digest(self.registry_archive), "2026.10.5", "registry-release", "2026.10.4-beta.2", health_timeout=0)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.registry_installs, [])

    def test_archive_update_records_actual_source_and_rollback_keeps_new_data(self):
        self.prepare_registry()
        result = self.manager.deploy_archive(self.registry_archive, deployment.digest(self.registry_archive), "2026.10.5", "archive-release", health_timeout=0)
        self.assertEqual(result["mode"], "archive")
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(result["afterInstallRecord"]["source"], "archive")
        self.assertEqual(self.registry_installs, [str((self.backups / "archive-release/package.tgz").resolve())])
        (self.data / "new-request.json").write_text('{"requestId":"new/AbC"}')
        restored = self.manager.rollback("archive-release", health_timeout=0)
        self.assertEqual(restored["rollbackHealth"]["pluginVersion"], "old")
        self.assertTrue((self.data / "new-request.json").exists())

    def test_archive_failed_health_reinstalls_the_actual_backup(self):
        self.prepare_registry()
        self.fail_new = True
        with self.assertRaises(deployment.DeploymentError):
            self.manager.deploy_archive(self.registry_archive, deployment.digest(self.registry_archive), "2026.10.5", "archive-release", health_timeout=0)
        self.assertEqual(self.calls, ["stop", "start", "stop", "start"])
        self.assertEqual(self.manager.health(False, timeout=0)["pluginVersion"], "old")
        self.assertEqual(json.loads((self.backups / "archive-release/manifest.json").read_text())["status"], "rolled_back")

    def test_archive_missing_dependency_stops_before_gateway_actions(self):
        archive = self.package(missing=True, version="2026.10.4-beta.1")
        with self.assertRaises(deployment.DeploymentError):
            self.manager.deploy_archive(archive, deployment.digest(archive), "2026.10.5", "archive-release", health_timeout=0)
        self.assertEqual(self.calls, [])

    def test_entrypoint_supports_full_package_and_rollback(self):
        process = subprocess.run(["bash", str(Path(__file__).with_name("deploy-gateway.sh")), "--help"], capture_output=True, text=True)
        self.assertEqual(process.returncode, 0)
        self.assertIn("--package", process.stdout)
        self.assertIn("--rollback", process.stdout)

    def test_frontend_uses_requested_ssh_endpoint_for_commands_and_uploads(self):
        entry_spec = importlib.util.spec_from_file_location("deploy_gateway_endpoint_entry", Path(__file__).with_name("deploy-gateway.py"))
        entry = importlib.util.module_from_spec(entry_spec)
        entry_spec.loader.exec_module(entry)
        archive = self.package()
        scripts = self.root / "scripts"
        scripts.mkdir()
        (scripts / "verify-isolated-v3.mjs").write_text("测试验证器")
        for arguments, host, port in [
            ([], "192.144.160.181", "5023"),
            (["--host", "operator@test-host", "--ssh-port", "6023"], "operator@test-host", "6023"),
        ]:
            with self.subTest(host=host, port=port):
                commands = []
                def run(command, **kwargs):
                    commands.append(command)
                    body = json.dumps({"ok": True, "result": {"sdkVersion": "2026.10.5"}}) if "input" in kwargs else ""
                    return subprocess.CompletedProcess(command, 0, body, "")
                argv = ["deploy-gateway.py", "--verify-only", "--package", str(archive), *arguments]
                with patch.object(entry, "ROOT", self.root), patch.object(entry.subprocess, "run", side_effect=run), patch.dict(entry.os.environ, {}, clear=True), patch("sys.argv", argv), patch("sys.stdout", new_callable=io.StringIO):
                    entry.main()
                self.assertEqual([command[0] for command in commands], ["ssh", "scp", "scp", "ssh"])
                for command in commands:
                    self.assertIn("Port=" + port, command)
                    if command[0] == "ssh":
                        self.assertEqual(command[-2], host)
                    else:
                        self.assertTrue(command[-1].startswith(host + ":/tmp/friday-next-deploy-"))


if __name__ == "__main__":
    unittest.main()
