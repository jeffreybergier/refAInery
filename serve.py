#!/usr/bin/env python3
"""Launch refAInery's development container with GitHub auth from 1Password."""

import argparse
import json
import os
from pathlib import Path
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


def main(test_directories=None, port=8080):
    print("\n🚀 refAInery\n" + "─" * 40)
    checkout = os.path.dirname(os.path.abspath(__file__))
    config_checkout = os.path.join(os.path.dirname(checkout), "refAInery-config")
    if test_directories:
        config_checkout, storage_checkout = map(str, test_directories)
    if not test_directories and (not os.path.isdir(config_checkout) or not os.path.exists(
        os.path.join(config_checkout, ".git")
    )):
        fail(
            f"configuration checkout is missing: {config_checkout}. "
            "Clone refAInery-config beside refAInery before launching."
        )
    print("\n🔐 1/5  Using fake credentials (TEST)..." if test_directories else
          "\n🔐 1/5  Getting GitHub credentials from 1Password...")
    credentials = ({"GITHUB_TOKEN": "refainery-test-not-a-secret",
                    "STORAGE_REPO": "https://example.invalid/test-storage.git"}
                   if test_directories else get_credentials())
    print("✅      Credential environment prepared")

    print("\n🐳 2/5  Checking container runtime...")
    engine, engine_name = select_engine()
    sdk_archives = os.path.expanduser("~/.altivec/.altivec-sdk")
    if not test_directories and not os.path.isdir(sdk_archives):
        fail(f"SDK archive directory does not exist: {sdk_archives}")
    print(f"✅      {engine_name.capitalize()} is ready")

    # The static in-container script never includes the secret. `-e GH_TOKEN`
    # asks the runtime to take it from this subprocess's environment, not argv.
    container_script = r'''set -euo pipefail
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
if [ "$REFAINERY_MODE" = test ]; then
  printf '\nTEST: fake credentials; skipping GitHub auth, SDK installation, and storage clone.\n'
else
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
fi
cd /app
# Downloads and immutable installation generations both live in the volume.
# A lock prevents simultaneous previews from replacing an active installation.
command -v flock >/dev/null || { echo 'flock is required.' >&2; exit 1; }
export npm_config_cache=/cache/npm
key=$({ cat package.json package-lock.json; node -p 'JSON.stringify([process.version, process.platform, process.arch])'; npm --version; printf 'production-ignore-scripts-v1'; } | sha256sum | cut -d ' ' -f 1)
deps="/cache/refainery/dependencies/$key"
mkdir -p "$deps"
(
  flock -x 9
  if [ ! -f "$deps/.complete" ] || [ ! -d "$deps/node_modules" ]; then
    rm -f "$deps/.complete"
    cp package.json package-lock.json "$deps/"
    printf 'Installing locked application dependencies in %s...\n' "$deps"
    # No production credentials are passed to npm.
    env -u GH_TOKEN -u STORAGE_REPO npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$deps"
    touch "$deps/.complete"
  fi
) 9>"$deps/.lock"
ln -s "$deps/node_modules" /app/node_modules
printf '\n🌐 Starting Node server on 0.0.0.0:8080...\n\n'
exec node /app/source/main.ts
'''

    print(f"\n📦 Starting container with {engine_name}...\n", flush=True)
    env = {key: value for key, value in os.environ.items()
           if key not in ("GH_TOKEN", "GITHUB_TOKEN", "STORAGE_REPO", "NODE_OPTIONS")}
    env["GH_TOKEN"] = credentials["GITHUB_TOKEN"]
    env["STORAGE_REPO"] = credentials["STORAGE_REPO"]
    container_name = f"refainery-{os.getpid()}"
    command = [
        engine, "run", "--rm", "--name", container_name,
        "-e", "GH_TOKEN",
        "-e", "STORAGE_REPO",
        "-e", "REFAINERY_HOST=0.0.0.0",
        "-e", f"REFAINERY_MODE={'test' if test_directories else 'production'}",
        "-e", f"REFAINERY_CONFIG_DIR=/app/config/{'test' if test_directories else 'prod'}",
        "-e", f"REFAINERY_STORAGE_DIR=/app/storage/{'test' if test_directories else 'prod'}",
        "-v", f"{checkout}/source:{WORKSPACE}/source:ro",
        "-v", f"{checkout}/package.json:{WORKSPACE}/package.json:ro",
        "-v", f"{checkout}/package-lock.json:{WORKSPACE}/package-lock.json:ro",
        # Development-only host checkout; agents cannot edit live config.
        "--mount", (
            f"type=bind,source={config_checkout},"
            f"target={WORKSPACE}/config{'/test' if test_directories else ''},readonly"
        ),
        *(["--mount", f"type=bind,source={storage_checkout},target=/app/storage/test,readonly"]
          if test_directories else [
              "-v", f"{sdk_archives}:/root/.altivec-sdk:ro",
              "-v", "developer_altivec-sdk-legacy:/osxcross/legacy/target/SDK",
              "-v", "developer_altivec-sdk-modern:/osxcross/modern/SDK",
          ]),
        "-v", "developer_cache:/cache",
        "-p", f"127.0.0.1:{port}:8080",
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


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test", action="store_true",
                        help="Use fictional fixtures; skip credentials, GitHub and SDK installation")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        fail("Port must be between 1 and 65535.")
    directories = None
    if args.test:
        root = Path(__file__).resolve().parent.parent
        directories = []
        for repository, filename in (("refAInery-config", "config.json"),
                                     ("refAInery-storage", "workshop.json")):
            directory = root / repository / "test"
            fixture = directory / filename
            if directory.is_symlink() or fixture.is_symlink():
                fail(f"Test fixtures must not be symlinks: {directory}")
            if not fixture.is_file():
                fail(f"Missing {fixture}. Check out the sibling {repository} repo.")
            directories.append(directory)
        print("\nTEST FACTORY: fictional fixtures; no real agents or credentials.")
    print(f"Preview: http://127.0.0.1:{args.port}", flush=True)
    return main(test_directories=directories, port=args.port)


if __name__ == "__main__":
    sys.exit(cli())
