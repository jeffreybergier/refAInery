#!/usr/bin/env python3
"""Compatibility alias for python3 serve.py --test."""

import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location(
    "refainery_launcher", Path(__file__).resolve().parents[1] / "serve.py")
container = importlib.util.module_from_spec(spec)
spec.loader.exec_module(container)


def main(argv=None):
    return container.cli(["--test", *(sys.argv[1:] if argv is None else argv)])


if __name__ == "__main__":
    sys.exit(main())
