"""Offline checks for the explicit live launcher; never reads real credentials."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    "run_once", Path(__file__).resolve().parents[1] / "run-once.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class RunOnceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.prompt = self.root / "prompt.txt"
        self.prompt.write_text("Offline test")
        self.enterContext(patch("sys.argv", ["run-once.py", "--prompt-file",
                                           str(self.prompt), "--config", str(self.root)]))
        self.enterContext(patch.object(launcher.shutil, "which", return_value="/test/tool"))
        self.fields = [
            {"label": "OPENROUTER_API_KEY", "value": "fictional-secret"},
            {"label": "MODEL_SELECTED", "value": "fictional/model"},
            {"label": "MODEL_REGISTRY", "value": "https://openrouter.ai/api/v1/models"},
            {"label": "GITHUB_TOKEN", "value": "unused-github-secret"},
        ]
        self.result = Mock(returncode=0, stdout=json.dumps({"fields": self.fields}))
        self.op = self.enterContext(patch.object(launcher.subprocess, "run", return_value=self.result))
        self.process = Mock()
        self.process.wait.return_value = 0
        self.popen = self.enterContext(patch.object(launcher.subprocess, "Popen", return_value=self.process))

    def test_only_required_credentials_in_child_environment_not_arguments(self):
        with patch.dict(launcher.os.environ, {"GH_TOKEN": "ambient", "NODE_OPTIONS": "unsafe", "ANTHROPIC_API_KEY": "ambient"}):
            self.assertEqual(launcher.main(), 0)
        args = self.popen.call_args
        self.assertNotIn("fictional-secret", " ".join(args.args[0]))
        env = args.kwargs["env"]
        self.assertEqual(env["OPENROUTER_API_KEY"], "fictional-secret")
        for key in ["GITHUB_TOKEN", "GH_TOKEN", "NODE_OPTIONS", "ANTHROPIC_API_KEY"]:
            self.assertNotIn(key, env)

    def test_op_failure_never_starts_node(self):
        self.result.returncode = 1
        with self.assertRaises(RuntimeError):
            launcher.main()
        self.popen.assert_not_called()

    def test_duplicate_field_rejected(self):
        self.fields.append(self.fields[0])
        self.result.stdout = json.dumps({"fields": self.fields})
        with self.assertRaises(RuntimeError):
            launcher.main()
        self.popen.assert_not_called()

    def test_missing_prompt_fails_before_secret_access(self):
        self.prompt.unlink()
        with self.assertRaises(RuntimeError):
            launcher.main()
        self.op.assert_not_called()
