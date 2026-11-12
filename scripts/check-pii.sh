#!/usr/bin/env bash
# Scan tracked or staged files for PII and secret-like data.
# Usage: scripts/check-pii.sh [--staged]
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 scripts/check_pii.py "$@"
