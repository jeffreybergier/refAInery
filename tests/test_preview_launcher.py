"""Offline checks for the shared container launcher in test mode."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "preview_launcher", Path(__file__).resolve().parents[1] / "serve.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class PreviewLauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="refainery test ")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        self.checkout = root / "refAInery"
        self.checkout.mkdir()
        for repository, filename in (("refAInery-config", "config.json"),
                                     ("refAInery-storage", "workshop.json")):
            directory = root / repository / "test"
            directory.mkdir(parents=True)
            (directory / filename).write_text("{}")
        self.enterContext(patch.object(launcher, "__file__",
                                      str(self.checkout / "serve.py")))
        self.credentials = self.enterContext(patch.object(
            launcher, "get_credentials", side_effect=AssertionError("No op")))
        self.enterContext(patch.object(launcher, "select_engine",
                                      return_value=("/test/docker", "docker")))
        self.process = Mock()
        self.process.wait.return_value = 0
        self.popen = self.enterContext(patch.object(
            launcher.subprocess, "Popen", return_value=self.process))
        self.run = self.enterContext(patch.object(launcher.subprocess, "run"))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    def test_fake_environment_read_only_fixtures_and_shared_cache(self):
        with patch.dict(os.environ, {"GH_TOKEN": "secret", "NODE_OPTIONS": "bad"}):
            self.assertEqual(launcher.cli(["--test", "--port", "8090"]), 0)
        command = self.popen.call_args.args[0]
        self.assertEqual(command[0], "/test/docker")
        self.assertIn("REFAINERY_MODE=test", command)
        self.assertIn("127.0.0.1:8090:8080", command)
        self.assertIn("developer_cache:/cache", command)
        for repository, target in (("config", "config"), ("storage", "storage")):
            self.assertIn(f"type=bind,source={self.checkout.parent}/refAInery-{repository}/test,target=/app/{target}/test,readonly", command)
        self.assertNotIn("developer_altivec-sdk-legacy:/osxcross/legacy/target/SDK", command)
        env = self.popen.call_args.kwargs["env"]
        self.assertEqual(env["GH_TOKEN"], "refainery-test-not-a-secret")
        self.assertEqual(env["STORAGE_REPO"], "https://example.invalid/test-storage.git")
        self.assertNotIn("NODE_OPTIONS", env)
        self.credentials.assert_not_called()
        self.assertIn('if [ "$REFAINERY_MODE" = test ]; then', command[-1])
        self.assertIn("npm_config_cache=/cache/npm", command[-1])
        self.assertIn("flock -x 9", command[-1])
        self.assertIn('ln -s "$deps/node_modules" /app/node_modules', command[-1])

    def test_missing_fixture_fails_without_starting(self):
        (self.checkout.parent / "refAInery-storage/test/workshop.json").unlink()
        with self.assertRaises(SystemExit):
            launcher.cli(["--test"])
        self.popen.assert_not_called()

    def test_symlink_fixture_is_rejected(self):
        fixture = self.checkout.parent / "refAInery-storage/test/workshop.json"
        fixture.unlink()
        fixture.symlink_to(self.checkout.parent / "refAInery-config/test/config.json")
        with self.assertRaises(SystemExit):
            launcher.cli(["--test"])
        self.popen.assert_not_called()

    def test_invalid_port_fails_without_starting(self):
        with self.assertRaises(SystemExit):
            launcher.cli(["--test", "--port", "0"])
        self.popen.assert_not_called()

    def test_exit_code_is_preserved(self):
        self.process.wait.return_value = 12
        self.assertEqual(launcher.cli(["--test"]), 12)

    def test_ctrl_c_stops_container(self):
        self.process.wait.side_effect = [KeyboardInterrupt, 0]
        self.assertEqual(launcher.cli(["--test"]), 130)
        self.assertEqual(self.run.call_args.args[0][1:4], ["stop", "--time", "5"])

    def test_slow_shutdown_kills_container(self):
        self.process.wait.side_effect = [KeyboardInterrupt, subprocess.TimeoutExpired("docker", 10), 0]
        self.assertEqual(launcher.cli(["--test"]), 130)
        self.assertEqual(self.run.call_args.args[0][1], "kill")


if __name__ == "__main__":
    unittest.main()
