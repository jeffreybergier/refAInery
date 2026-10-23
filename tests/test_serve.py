"""Offline launcher checks: python3 -B -m unittest discover -s tests -v."""

import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    "serve", Path(__file__).resolve().parents[1] / "serve.py"
)
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class ConfigMountTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="refainery test ")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.checkout = root / "refAInery"
        self.checkout.mkdir()
        self.config = root / "refAInery-config"
        self.config.mkdir()
        (self.config / ".git").mkdir()
        self.sdk = root / "sdk"
        self.sdk.mkdir()

        self.credentials = self.enterContext(patch.object(
            serve, "get_credentials", return_value={
                "GITHUB_TOKEN": "offline-test-token",
                "STORAGE_REPO": "https://example.invalid/storage.git",
            }
        ))
        self.engine = self.enterContext(patch.object(
            serve, "select_engine", return_value=("/test/docker", "docker")
        ))
        self.process = Mock()
        self.process.wait.return_value = 0
        self.popen = self.enterContext(patch.object(
            serve.subprocess, "Popen", return_value=self.process
        ))
        self.enterContext(patch.object(
            serve, "__file__", str(self.checkout / "serve.py")
        ))
        self.enterContext(patch.object(
            serve.os.path, "expanduser", return_value=str(self.sdk)
        ))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.errors = self.enterContext(
            contextlib.redirect_stderr(io.StringIO())
        )

    def test_read_only_mount_for_both_engines(self):
        for engine in ("docker", "podman"):
            with self.subTest(engine=engine):
                self.engine.return_value = (f"/test/{engine}", engine)
                self.assertEqual(serve.main(), 0)
                command = self.popen.call_args.args[0]
                self.assertEqual(command[0], f"/test/{engine}")
                self.assertEqual(command.count("--mount"), 1)
                self.assertEqual(
                    command[command.index("--mount") + 1],
                    f"type=bind,source={self.config},target=/app/config,readonly",
                )
                self.assertIn(f"{self.checkout}/source:/app/source:ro", command)
                self.assertNotIn("offline-test-token", " ".join(command))
                self.assertEqual(
                    self.popen.call_args.kwargs["env"]["GH_TOKEN"],
                    "offline-test-token",
                )

    def test_local_assets_and_loopback_publishing(self):
        self.assertEqual(serve.main(), 0)
        command = self.popen.call_args.args[0]
        for filename in ("package.json", "package-lock.json"):
            self.assertIn(
                f"{self.checkout}/{filename}:/app/{filename}:ro", command
            )
        self.assertEqual(command[command.index("-p") + 1],
                         "127.0.0.1:8080:8080")
        script = command[-1]
        self.assertIn("npm ci --omit=dev --ignore-scripts", script)
        self.assertIn("exec node /app/source/main.ts", script)

    def assert_missing_checkout_fails_early(self):
        with self.assertRaises(SystemExit) as error:
            serve.main()
        self.assertEqual(error.exception.code, 1)
        self.assertIn(str(self.config), self.errors.getvalue())
        self.assertIn("Clone refAInery-config", self.errors.getvalue())
        self.credentials.assert_not_called()
        self.engine.assert_not_called()
        self.popen.assert_not_called()

    def test_missing_directory_fails_before_credentials(self):
        (self.config / ".git").rmdir()
        self.config.rmdir()
        self.assert_missing_checkout_fails_early()

    def test_non_checkout_directory_fails_before_credentials(self):
        (self.config / ".git").rmdir()
        self.assert_missing_checkout_fails_early()

    def test_container_exit_code_is_preserved(self):
        self.process.wait.return_value = 17
        self.assertEqual(serve.main(), 17)


if __name__ == "__main__":
    unittest.main()
