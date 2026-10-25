#!/usr/bin/env python3
"""Docker-only refAInery: two environments, one application."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def production_key():
    result = subprocess.run(
        ["op", "item", "get", "Dev Key - refAInery", "--format", "json"],
        capture_output=True, text=True, check=True,
    )
    for field in json.loads(result.stdout).get("fields", []):
        if field.get("label") == "OPENROUTER_API_KEY" and field.get("value"):
            return field["value"]
    raise RuntimeError("1Password item has no OPENROUTER_API_KEY")


def container_name(args):
    return f"refainery-{args.environment}-{args.action}-{os.getpid()}"


def command(args):
    """Build one Compose command; the host never executes Node or npm."""
    base = ["docker", "compose", "--project-name", f"refainery-{args.environment}",
            "--file", str(ROOT / "compose.yaml")]
    if args.action == "build":
        return base + ["build", "app"]
    if args.action == "serve":
        return base + ["run", "--rm", "--name", container_name(args), "--service-ports", "app"]
    run = base + ["run", "--rm", "--name", container_name(args), "-T"]
    if args.action == "run":
        if args.prompt_file:
            run += ["--volume", f"{args.prompt_file.resolve()}:/app/request.md:ro"]
        return run + ["app", "node", "source/run-once.ts",
                      *(["--prompt-file", "/app/request.md"] if args.prompt_file else []),
                      *(["--scenario", args.scenario] if args.scenario else [])]
    if args.action == "check":
        return run + ["app", "bash", "tests/check.sh"]
    return run + ["app", "node", "source/reset-test.ts"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("environment", choices=["test", "prod"])
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("build", help="Build/update the Docker image, including test tools")
    serve = sub.add_parser("serve", help="View saved workflow; does not dispatch work")
    serve.add_argument("--port", type=int, default=8080)
    run = sub.add_parser("run", help="Execute one request with real Pi sessions")
    run.add_argument("--prompt-file", type=Path)
    run.add_argument("--scenario", help="Test response script (default: happy-path)")
    sub.add_parser("check", help="Run type, unit, integration and browser checks in Docker")
    sub.add_parser("reset", help="Remove generated test records, retaining fixtures")
    args = parser.parse_args(argv)
    if args.action in ("reset", "check") and args.environment != "test":
        parser.error(f"{args.action} is a test action")
    if args.action == "run":
        if args.environment == "prod" and (not args.prompt_file or args.scenario):
            parser.error("prod run requires --prompt-file and does not use scenarios")
        if args.prompt_file and not args.prompt_file.is_file():
            parser.error("prompt file does not exist")
    env = dict(os.environ)
    env.update(REFAINERY_ENV=args.environment,
               REFAINERY_HOST_STORAGE=str(ROOT.parent / "refAInery-storage" / args.environment),
               REFAINERY_PORT=str(getattr(args, "port", 8080)),
               OPENROUTER_API_KEY="")
    if args.environment == "prod" and args.action == "run":
        env["OPENROUTER_API_KEY"] = production_key()
    try:
        return subprocess.call(command(args), cwd=ROOT, env=env)
    except KeyboardInterrupt:
        # Compose's client may exit before the app has finished worker teardown.
        if args.action != "build":
            subprocess.run(["docker", "stop", "--time", "60", container_name(args)],
                           check=False, stdout=subprocess.DEVNULL)
        return 130


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError):
        print("Launch failed. Check Docker, paths, and (for prod run) 1Password access.", file=sys.stderr)
        sys.exit(1)
