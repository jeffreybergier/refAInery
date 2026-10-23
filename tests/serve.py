#!/usr/bin/env python3
"""Fake-data counterpart to ../serve.py; no credentials or containers required."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

CHECKOUT = Path(__file__).resolve().parents[1]


def fail(message):
    print(f"\nTest preflight failed: {message}\n", file=sys.stderr)
    raise SystemExit(1)


def fixture_directory(repository, filename):
    directory = CHECKOUT.parent / repository / "test"
    fixture = directory / filename
    if directory.is_symlink() or fixture.is_symlink():
        fail(f"Test fixtures must not be symlinks: {directory}")
    if not fixture.is_file():
        fail(f"Missing {fixture}. Check out the sibling {repository} repo.")
    return directory


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        fail("Port must be between 1 and 65535.")

    print("\nrefAInery / TEST FACTORY", flush=True)
    print("Fake data only. No credentials, Docker, SDKs, Pi, or orchestration.\n")
    node = shutil.which("node")
    if not node:
        fail("Node.js 22.18+ is required on PATH.")
    if not (CHECKOUT / "node_modules/bootstrap/dist/css/bootstrap.min.css").is_file():
        fail("Run `npm ci --ignore-scripts` in refAInery first.")
    config = fixture_directory("refAInery-config", "config.json")
    storage = fixture_directory("refAInery-storage", "workshop.json")

    # Do not inherit provider tokens, NODE_OPTIONS, or production data settings.
    # The fake server requires no authentication material from any source.
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP")
           if key in os.environ}
    env.update({
        "REFAINERY_MODE": "test",
        "REFAINERY_CONFIG_DIR": str(config),
        "REFAINERY_STORAGE_DIR": str(storage),
        "REFAINERY_HOST": "127.0.0.1",
        "REFAINERY_PORT": str(args.port),
    })
    print(f"Config:  {config}\nStorage: {storage}")
    print(f"Preview: http://127.0.0.1:{args.port}", flush=True)
    process = None
    try:
        process = subprocess.Popen(
            [node, str(CHECKOUT / "source/main.ts")], cwd=CHECKOUT,
            env=env, start_new_session=True,
        )
        return process.wait()
    except FileNotFoundError:
        fail("Node.js disappeared before startup.")
    except KeyboardInterrupt:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        print("\nTest server stopped; fixtures unchanged.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
