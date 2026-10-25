#!/usr/bin/env python3
"""Compatibility alias; prefer refinery.py test|prod serve."""
import sys
from refinery import main

if __name__ == "__main__":
    args = sys.argv[1:]
    environment = "test" if "--test" in args else "prod"
    sys.exit(main([environment, "serve", *[arg for arg in args if arg != "--test"]]))
