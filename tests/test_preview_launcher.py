"""Offline tests for the fake launcher. Never invoke Node or external services."""

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
    "preview_launcher", Path(__file__).with_name("serve.py")
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class PreviewLauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.checkout = root / "refAInery"
        bootstrap = self.checkout / "node_modules/bootstrap/dist/css/bootstrap.min.css"
        bootstrap.parent.mkdir(parents=True)
        bootstrap.write_text("/* fake */")
        for repository, filename in (("refAInery-config", "config.json"),
                                     ("refAInery-storage", "workshop.json")):
            directory = root / repository / "test"
            directory.mkdir(parents=True)
            (directory / filename).write_text("{}")
        self.enterContext(patch.object(launcher, "CHECKOUT", self.checkout))
        self.enterContext(patch.object(launcher.shutil, "which", return_value="/test/node"))
        self.process = Mock()
        self.process.wait.return_value = 0
        self.popen = self.enterContext(patch.object(
            launcher.subprocess, "Popen", return_value=self.process))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    def test_only_fake_paths_and_no_inherited_credentials(self):
        with patch.dict(os.environ, {"GH_TOKEN": "secret", "NODE_OPTIONS": "bad",
                                    "REFAINERY_MODE": "production"}):
            self.assertEqual(launcher.main(["--port", "8090"]), 0)
        arguments = self.popen.call_args
        self.assertEqual(arguments.args[0], ["/test/node", str(self.checkout / "source/main.ts")])
        env = arguments.kwargs["env"]
        self.assertEqual(env["REFAINERY_MODE"], "test")
        self.assertEqual(env["REFAINERY_HOST"], "127.0.0.1")
        self.assertEqual(env["REFAINERY_PORT"], "8090")
        self.assertTrue(env["REFAINERY_CONFIG_DIR"].endswith("refAInery-config/test"))
        self.assertTrue(env["REFAINERY_STORAGE_DIR"].endswith("refAInery-storage/test"))
        self.assertNotIn("GH_TOKEN", env)
        self.assertNotIn("NODE_OPTIONS", env)

    def test_missing_fixture_fails_without_starting(self):
        (self.checkout.parent / "refAInery-storage/test/workshop.json").unlink()
        with self.assertRaises(SystemExit):
            launcher.main([])
        self.popen.assert_not_called()

    def test_symlink_fixture_is_rejected(self):
        fixture = self.checkout.parent / "refAInery-storage/test/workshop.json"
        fixture.unlink()
        fixture.symlink_to(self.checkout / "node_modules/bootstrap/dist/css/bootstrap.min.css")
        with self.assertRaises(SystemExit):
            launcher.main([])
        self.popen.assert_not_called()

    def test_invalid_port_fails_without_starting(self):
        with self.assertRaises(SystemExit):
            launcher.main(["--port", "0"])
        self.popen.assert_not_called()

    def test_exit_code_is_preserved(self):
        self.process.wait.return_value = 12
        self.assertEqual(launcher.main([]), 12)

    def test_ctrl_c_terminates_child(self):
        self.process.wait.side_effect = [KeyboardInterrupt, 0]
        self.assertEqual(launcher.main([]), 130)
        self.process.terminate.assert_called_once()

    def test_slow_shutdown_kills_child(self):
        self.process.wait.side_effect = [KeyboardInterrupt, subprocess.TimeoutExpired("node", 5), 0]
        self.assertEqual(launcher.main([]), 130)
        self.process.kill.assert_called_once()


if __name__ == "__main__":
    unittest.main()
