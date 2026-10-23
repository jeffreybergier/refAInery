#!/usr/bin/env python3
"""Launch refAInery's development container with GitHub auth from 1Password."""

import json
import os
import shutil
import subprocess
import sys

IMAGE = "ghcr.io/jeffreybergier/altivec-intelligence:latest"
ITEM = "Dev Key - refAInery"
FIELD = "GITHUB_TOKEN"
WORKSPACE = "/repo/user"


def fail(message):
    print(f"Preflight failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def get_github_token():
    """Fetch the token without displaying it or putting it in process arguments."""
    op = shutil.which("op")
    if not op:
        fail("1Password CLI (`op`) is not installed or not on PATH.")

    result = subprocess.run(
        [op, "item", "get", ITEM, "--format", "json"],
        capture_output=True,
        text=True,
    )
    if result.returncode:
        fail("could not read the 1Password item; sign in to `op` and check access.")

    try:
        item = json.loads(result.stdout)
        fields = item.get("fields", [])
        values = [field.get("value") for field in fields
                  if field.get("label") == FIELD]
    except (json.JSONDecodeError, AttributeError, TypeError):
        fail("1Password returned an unexpected item format.")

    if not values or not isinstance(values[0], str) or not values[0]:
        fail(f"item '{ITEM}' has no non-empty '{FIELD}' field.")
    return values[0]


def select_engine():
    # Prefer Docker, then Podman, but require its daemon/service to be reachable.
    for name in ("docker", "podman"):
        executable = shutil.which(name)
        if executable:
            check = subprocess.run(
                [executable, "info"], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if check.returncode == 0:
                return executable, name
    fail("neither Docker nor Podman is installed and running.")


def main():
    print("Preflight 1/3: retrieving GitHub token from 1Password...")
    token = get_github_token()

    print("Preflight 2/3: checking container runtime...")
    engine, engine_name = select_engine()
    checkout = os.path.dirname(os.path.abspath(__file__))

    # The static in-container script never includes the secret. `-e GH_TOKEN`
    # asks the runtime to take it from this subprocess's environment, not argv.
    container_script = r'''set -eu
command -v gh >/dev/null || { echo "gh CLI is missing from the image." >&2; exit 1; }
command -v git >/dev/null || { echo "git CLI is missing from the image." >&2; exit 1; }
echo "Checking GitHub CLI authentication..."
gh auth status --hostname github.com
echo "Authenticated GitHub user:"
gh api user --jq .login
gh auth setup-git --hostname github.com
# Ask Git's configured credential helper for HTTPS credentials without ever
# printing the returned password/token.
if printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | grep -q '^password=.'; then
  echo "Git HTTPS credential helper returned a credential."
else
  echo "Git could not obtain an HTTPS credential from gh." >&2
  exit 1
fi
echo "GitHub authentication preflight passed."
cd /repo/user
exec bash -l
'''

    print(f"Preflight 3/3: starting {engine_name}, checking gh and git auth...", flush=True)
    env = os.environ.copy()
    env["GH_TOKEN"] = token
    command = [
        engine, "run", "--rm", "-it",
        "-e", "GH_TOKEN",
        "-v", f"{checkout}:{WORKSPACE}",
        "-w", WORKSPACE,
        "--entrypoint", "bash",
        IMAGE,
        "-lc", container_script,
    ]
    try:
        return subprocess.run(command, env=env).returncode
    except FileNotFoundError:
        fail(f"{engine_name} disappeared before it could start.")
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
