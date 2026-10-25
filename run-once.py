#!/usr/bin/env python3
"""Explicit supervised live run; credentials never appear in argv or files."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    checkout = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--storage", type=Path, default=checkout / "build/supervised-storage")
    parser.add_argument("--config", type=Path, default=checkout.parent / "refAInery-config/prod")
    args = parser.parse_args()
    if not args.prompt_file.is_file() or not args.config.is_dir():
        raise RuntimeError("Prompt/config path unavailable")
    for command in ["op", "node", "docker"]:
        if not shutil.which(command):
            raise RuntimeError("Required executable unavailable")
    result = subprocess.run(
        ["op", "item", "get", "Dev Key - refAInery", "--format", "json"],
        capture_output=True, text=True, timeout=90,
    )
    if result.returncode:
        raise RuntimeError("1Password access failed; approve CLI access and retry explicitly")
    fields = {}
    for field in json.loads(result.stdout).get("fields", []):
        name = field.get("label")
        if name in ("OPENROUTER_API_KEY", "MODEL_REGISTRY", "MODEL_SELECTED"):
            if name in fields:
                raise RuntimeError("Duplicate model configuration field")
            value = field.get("value")
            if not isinstance(value, str):
                raise RuntimeError("Invalid model configuration field")
            fields[name] = value.strip()
    if len(fields) != 3 or not all(fields.values()):
        raise RuntimeError("Incomplete model configuration")
    # No ambient model credentials, Pi settings, GitHub tokens or NODE_OPTIONS.
    env = {key: os.environ[key] for key in
           ("PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG")
           if key in os.environ}
    env.update(fields)
    env.update(REFAINERY_STORAGE_DIR=str(args.storage.resolve()),
               REFAINERY_CONFIG_DIR=str(args.config.resolve()),
               REFAINERY_PROMPT_FILE=str(args.prompt_file.resolve()))
    process = subprocess.Popen(["node", "source/run-once.ts"], cwd=checkout, env=env)
    try:
        return process.wait()
    except KeyboardInterrupt:
        # Child receives the terminal interrupt too and performs worker teardown.
        try:
            return process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            process.terminate()
            print("Cleanup timeout: inspect refainery-* containers and writer lock before retrying.", file=sys.stderr)
            return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired):
        print("Live launcher preflight failed. Check paths, executables, and 1Password approval. Credential output withheld.", file=sys.stderr)
        raise SystemExit(1)
