#!/usr/bin/env python3
"""Launch refAInery's development container with GitHub auth from 1Password."""

import json
import os
import shutil
import signal
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
    checkout = os.path.dirname(os.path.abspath(__file__))
    config_checkout = os.path.join(os.path.dirname(checkout), "refAInery-config")
    if not os.path.isdir(config_checkout) or not os.path.exists(
        os.path.join(config_checkout, ".git")
    ):
        fail(
            f"configuration checkout is missing: {config_checkout}. "
            "Clone refAInery-config beside refAInery before launching."
        )
    print("\n🔐 1/5  Getting GitHub credentials from 1Password...")
    credentials = get_credentials()
    print("✅      GitHub token and storage repository retrieved")

    print("\n🐳 2/5  Checking container runtime...")
    engine, engine_name = select_engine()
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
command -v npm >/dev/null || { echo "❌ npm is missing from the image." >&2; exit 1; }
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error("Node.js 22.18+ is required.");
  process.exit(1);
}'
printf '\n🔑 3/5  Checking GitHub authentication...\n\n'
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
printf '\n🧰 4/5  Checking Altivec SDK installations...\n\n'
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
printf '\n📦 5/5  Cloning private storage repository...\n'
git clone "$STORAGE_REPO" /app/storage
printf '\n🌐 Starting Hello World server on 0.0.0.0:8080...\n\n'
cd /app
printf 'Installing locked application dependencies...\n'
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
exec node /app/source/main.ts
'''

    print(f"\n📦 Starting container with {engine_name}...\n", flush=True)
    env = os.environ.copy()
    env["GH_TOKEN"] = credentials["GITHUB_TOKEN"]
    env["STORAGE_REPO"] = credentials["STORAGE_REPO"]
    container_name = f"refainery-{os.getpid()}"
    command = [
        engine, "run", "--rm", "--name", container_name,
        "-e", "GH_TOKEN",
        "-e", "STORAGE_REPO",
        "-e", "REFAINERY_MODE=production",
        "-e", "REFAINERY_CONFIG_DIR=/app/config/prod",
        "-e", "REFAINERY_STORAGE_DIR=/app/storage/prod",
        "-v", f"{sdk_archives}:/root/.altivec-sdk:ro",
        "-v", f"{checkout}/source:{WORKSPACE}/source:ro",
        "-v", f"{checkout}/package.json:{WORKSPACE}/package.json:ro",
        "-v", f"{checkout}/package-lock.json:{WORKSPACE}/package-lock.json:ro",
        # Development-only host checkout; agents cannot edit live config.
        "--mount", (
            f"type=bind,source={config_checkout},"
            f"target={WORKSPACE}/config,readonly"
        ),
        "-v", "developer_altivec-sdk-legacy:/osxcross/legacy/target/SDK",
        "-v", "developer_altivec-sdk-modern:/osxcross/modern/SDK",
        "-v", "developer_cache:/cache",
        "-p", "127.0.0.1:8080:8080",
        "-w", WORKSPACE,
        "--entrypoint", "bash",
        IMAGE,
        "-lc", container_script,
    ]
    process = None
    try:
        # Keep the container client out of the terminal's foreground process
        # group so this launcher can handle Ctrl-C and stop the container.
        process = subprocess.Popen(command, env=env, start_new_session=True)
        return process.wait()
    except FileNotFoundError:
        fail(f"{engine_name} disappeared before it could start.")
    except KeyboardInterrupt:
        # Ignore additional Ctrl-C presses during cleanup; they otherwise can
        # interrupt the stop request and leave the container running.
        previous_handler = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            subprocess.run(
                [engine, "stop", "--time", "5", container_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
                check=False,
            )
            if process is not None:
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    subprocess.run(
                        [engine, "kill", container_name],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=10,
                        check=False,
                    )
                    process.wait(timeout=10)
        finally:
            signal.signal(signal.SIGINT, previous_handler)
        print("\n🛑 Server stopped; container removed.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
