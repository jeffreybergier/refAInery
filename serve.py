#!/usr/bin/env python3
"""Launch refAInery's development container with GitHub auth from 1Password."""

import json
import os
import shutil
import subprocess
import sys

IMAGE = "ghcr.io/jeffreybergier/altivec-intelligence:latest"
ITEM = "Dev Key - refAInery"
FIELDS = ("GITHUB_TOKEN", "STORAGE_REPO")
WORKSPACE = "/app"


def fail(message):
    print(f"\n❌ Preflight failed: {message}\n", file=sys.stderr)
    raise SystemExit(1)


def get_credentials():
    """Fetch required values without displaying them or putting them in argv."""
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
        item_fields = item.get("fields", [])
        credentials = {}
        for name in FIELDS:
            values = [field.get("value") for field in item_fields
                      if field.get("label") == name]
            if not values or not isinstance(values[0], str) or not values[0]:
                fail(f"item '{ITEM}' has no non-empty '{name}' field.")
            credentials[name] = values[0]
    except (json.JSONDecodeError, AttributeError, TypeError):
        fail("1Password returned an unexpected item format.")
    return credentials


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
    print("\n🚀 refAInery\n" + "─" * 40)
    print("\n🔐 1/3  Getting GitHub credentials from 1Password...")
    credentials = get_credentials()
    print("✅      GitHub token and storage repository retrieved")

    print("\n🐳 2/3  Checking container runtime...")
    engine, engine_name = select_engine()
    checkout = os.path.dirname(os.path.abspath(__file__))
    sdk_archives = os.path.expanduser("~/.altivec/.altivec-sdk")
    if not os.path.isdir(sdk_archives):
        fail(f"SDK archive directory does not exist: {sdk_archives}")
    print(f"✅      {engine_name.capitalize()} is ready")

    # The static in-container script never includes the secret. `-e GH_TOKEN`
    # asks the runtime to take it from this subprocess's environment, not argv.
    container_script = r'''set -eu
command -v gh >/dev/null || { echo "❌ gh CLI is missing from the image." >&2; exit 1; }
command -v git >/dev/null || { echo "❌ git CLI is missing from the image." >&2; exit 1; }
command -v altivec-sdk >/dev/null || { echo "❌ altivec-sdk is missing from the image." >&2; exit 1; }
command -v node >/dev/null || { echo "❌ Node.js is missing from the image." >&2; exit 1; }
printf '\n🔑 3/4  Checking GitHub authentication...\n\n'
printf '   gh auth status\n'
gh auth status --hostname github.com
printf '\n👤 Authenticated GitHub user: '
gh api user --jq .login
gh auth setup-git --hostname github.com
# Ask Git's configured credential helper for HTTPS credentials without ever
# printing the returned password/token.
if printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | grep -q '^password=.'; then
  echo "✅ Git HTTPS credential is available."
else
  echo "❌ Git could not obtain an HTTPS credential from gh." >&2
  exit 1
fi
printf '\n✅ GitHub authentication preflight passed.\n'
printf '\n🧰 4/4  Checking Altivec SDK installations...\n\n'
sdk_status=$(altivec-sdk status)
printf '%s\n' "$sdk_status"
sdks_installed() {
  printf '%s\n' "$sdk_status" | grep -Eq '^MacOSX10\.5[[:space:]].*[[:space:]]installed[[:space:]]*$' &&
  printf '%s\n' "$sdk_status" | grep -Eq '^MacOSX11\.3[[:space:]].*[[:space:]]installed[[:space:]]*$' &&
  printf '%s\n' "$sdk_status" | grep -Eq '^iPhoneOS8\.4[[:space:]].*[[:space:]]installed[[:space:]]*$'
}
if ! sdks_installed; then
  printf '\n📋 SDKs need installation; checking available archives...\n'
  altivec-sdk preflight
  printf '\n📥 Installing missing SDKs...\n'
  altivec-sdk install
  sdk_status=$(altivec-sdk status)
  printf '%s\n' "$sdk_status"
  sdks_installed || { echo "❌ SDK installation verification failed." >&2; exit 1; }
fi
printf '\n✅ All Altivec SDKs are installed.\n'
printf '\n📦 Cloning private storage repository...\n'
git clone "$STORAGE_REPO" /app/storage
printf '\n🌐 Starting Hello World server on 0.0.0.0:8080...\n\n'
cd /app
exec node /app/source/server.ts
'''

    print(f"\n📦 Starting container with {engine_name}...\n", flush=True)
    env = os.environ.copy()
    env["GH_TOKEN"] = credentials["GITHUB_TOKEN"]
    env["STORAGE_REPO"] = credentials["STORAGE_REPO"]
    container_name = f"refainery-{os.getpid()}"
    command = [
        engine, "run", "--rm", "--name", container_name, "-it",
        "-e", "GH_TOKEN",
        "-e", "STORAGE_REPO",
        "-v", f"{sdk_archives}:/root/.altivec-sdk:ro",
        "-v", f"{checkout}/source:{WORKSPACE}/source:ro",
        "-v", "developer_altivec-sdk-legacy:/osxcross/legacy/target/SDK",
        "-v", "developer_altivec-sdk-modern:/osxcross/modern/SDK",
        "-v", "developer_cache:/cache",
        "-p", "0.0.0.0:8080:8080",
        "-w", WORKSPACE,
        "--entrypoint", "bash",
        IMAGE,
        "-lc", container_script,
    ]
    process = None
    try:
        process = subprocess.Popen(command, env=env)
        return process.wait()
    except FileNotFoundError:
        fail(f"{engine_name} disappeared before it could start.")
    except KeyboardInterrupt:
        # Ctrl-C can interrupt the attached Docker/Podman client before it
        # stops the container. Explicitly stop it so it cannot outlive us.
        subprocess.run(
            [engine, "stop", "--time", "5", container_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if process is not None:
            process.wait()
        print("\n🛑 Server stopped; container removed.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
