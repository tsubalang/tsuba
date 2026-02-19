#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_PROOF_DIR="$(cd "$ROOT_DIR/.." && pwd)/proof-is-in-the-pudding"

PROOF_DIR="$DEFAULT_PROOF_DIR"
REQUIRE=false

print_help() {
  cat <<'EOF_HELP'
Usage: ./scripts/verify-proof.sh [--repo <path>] [--require]

Options:
  --repo <path>  Proof repo root (default: ../proof-is-in-the-pudding)
  --require      Fail if proof repo/scripts are missing
  -h, --help     Show this help
EOF_HELP
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --repo)
      shift
      if [ -z "${1:-}" ]; then
        echo "FAIL: --repo requires a path"
        exit 2
      fi
      PROOF_DIR="$1"
      shift
      ;;
    --require)
      REQUIRE=true
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "FAIL: unknown arg: $1"
      print_help
      exit 2
      ;;
  esac
done

VERIFY_SCRIPT="$PROOF_DIR/scripts/verify-all.sh"

if [ ! -d "$PROOF_DIR" ] || [ ! -f "$VERIFY_SCRIPT" ]; then
  if [ "$REQUIRE" = true ]; then
    echo "FAIL: proof repo/verify script not found at: $PROOF_DIR"
    exit 1
  fi
  echo "SKIP: proof repo/verify script not found at: $PROOF_DIR"
  exit 0
fi

echo "==> Running proof verification from: $PROOF_DIR"
bash "$VERIFY_SCRIPT"
echo "Proof verification complete."
