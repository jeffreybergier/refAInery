"""Launcher construction tests. No real Docker or 1Password calls here."""
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import refinery


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.call = self.enterContext(patch.object(refinery.subprocess, "call", return_value=0))
        self.key = self.enterContext(patch.object(refinery, "production_key", return_value="test-secret"))

    def launch(self, *args):
        self.assertEqual(refinery.main(list(args)), 0)
        return self.call.call_args.args[0], self.call.call_args.kwargs["env"]

    def test_test_actions_only_use_docker_and_test_mounts(self):
        for action in ["build", "serve", "run", "check", "reset"]:
            with self.subTest(action=action):
                command, env = self.launch("test", action)
                self.assertEqual(command[:2], ["docker", "compose"])
                self.assertEqual(env["REFAINERY_ENV"], "test")
                self.assertTrue(env["REFAINERY_HOST_STORAGE"].endswith("refAInery-storage/test"))
                self.assertEqual(env["OPENROUTER_API_KEY"], "")
        self.key.assert_not_called()

    def test_prod_view_does_not_require_1password(self):
        command, env = self.launch("prod", "serve", "--port", "8090")
        self.assertIn("--service-ports", command)
        self.assertEqual(env["REFAINERY_ENV"], "prod")
        self.assertEqual(env["REFAINERY_PORT"], "8090")
        self.key.assert_not_called()

    def test_prod_run_mounts_prompt_and_passes_key_only_in_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            prompt = Path(directory) / "request.md"
            prompt.write_text("Test")
            command, env = self.launch("prod", "run", "--prompt-file", str(prompt))
            self.assertIn(f"{prompt}:/app/request.md:ro", command)
            self.assertEqual(env["OPENROUTER_API_KEY"], "test-secret")
            self.assertNotIn("test-secret", " ".join(command))
            self.assertEqual(command[-4:], ["node", "source/run-once.ts", "--prompt-file", "/app/request.md"])
        self.key.assert_called_once()

    def test_test_run_accepts_scenario(self):
        command, _ = self.launch("test", "run", "--scenario", "happy-path")
        self.assertEqual(command[-2:], ["--scenario", "happy-path"])

    def test_no_custom_environment_roots(self):
        for option in ["--storage", "--config"]:
            with self.assertRaises(SystemExit):
                refinery.main(["test", "run", option, "/tmp/custom"])
        self.call.assert_not_called()

    def test_production_run_needs_prompt(self):
        with self.assertRaises(SystemExit):
            refinery.main(["prod", "run"])
        self.key.assert_not_called()
        self.call.assert_not_called()

    def test_interrupt_stops_the_owned_container(self):
        self.call.side_effect = KeyboardInterrupt
        with patch.object(refinery.subprocess, "run") as stop:
            self.assertEqual(refinery.main(["test", "serve"]), 130)
            command = stop.call_args.args[0]
            self.assertEqual(command[:4], ["docker", "stop", "--time", "60"])
            self.assertTrue(command[4].startswith("refainery-test-serve-"))

    def test_compatibility_aliases_delegate_to_container_launcher(self):
        import runpy
        for name, args, expected in [
            ("serve.py", ["--test"], ["test", "serve"]),
            ("run-once.py", ["--test", "--scenario", "happy-path"], ["test", "run", "--scenario", "happy-path"]),
        ]:
            with patch.object(refinery, "main", return_value=0) as main:
                with patch("sys.argv", [name, *args]), self.assertRaises(SystemExit):
                    runpy.run_path(str(refinery.ROOT / name), run_name="__main__")
                main.assert_called_once_with(expected)
