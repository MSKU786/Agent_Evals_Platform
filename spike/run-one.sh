#!/usr/bin/env bash
#
# Phase-0 spike entry point.
#
# Runs ONE Hermes trial in an isolated, throwaway HERMES_HOME and prints the
# trajectory as JSON on stdout:  {"finalAnswer": ..., "steps": [...], "tokens": {...}}
#
# This is the Phase-0 exit check and the seed of the real AgentRunner: each
# trial is a one-shot `hermes chat -q` in its own Docker volume, so memory,
# auto-created skills and session history cannot leak between trials.
#
#   Usage:   ./run-one.sh ["<prompt>"]
#   Knobs:   MODEL, PROVIDER, TOOLSETS, SKILL, MEMORY, MAX_TURNS, KEEP
#
# Requires: Docker running, the pinned image present, GEMINI_API_KEY in ../.env
#
set -euo pipefail

# Docker path args contain ":/opt/data" etc.; stop Git-Bash/MSYS from rewriting
# them into Windows paths (that silently breaks `-v` mounts and `docker cp`).
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Pinned image (prebuilt, from Docker Hub). See docs/hermes-findings.md for why
# we pull rather than build in this environment.
IMAGE="${HERMES_IMAGE:-nousresearch/hermes-agent:v2026.9.24}"

PROMPT="${1:-Use the terminal to run \`echo 42 > answer.txt\` and then \`cat answer.txt\`, then report the exact contents of the file.}"
MODEL="${MODEL:-gemini-3.8-flash}"
PROVIDER="${PROVIDER:-gemini}"
TOOLSETS="${TOOLSETS:-terminal}"
SKILL="${SKILL:-changelog-style}"
MEMORY="${MEMORY:-true}"
MAX_TURNS="${MAX_TURNS:-20}"

# --- Secrets: read the key from .env without printing it -------------------
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "run-one.sh: $PROJECT_DIR/.env not found" >&2; exit 1
fi
GEMINI_API_KEY="$(grep -E '^GEMINI_API_KEY=' "$PROJECT_DIR/.env" | head -1 | cut -d= -f2-)"
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "run-one.sh: GEMINI_API_KEY missing from .env" >&2; exit 1
fi
export GEMINI_API_KEY

STAMP="$(date +%Y%m%d_%H%M%S)_$$"
VOL="hermes_spike_${STAMP}"
CID=""
cleanup() {
  [[ -n "$CID" ]] && docker rm -f "$CID" >/dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != "1" ]]; then docker volume rm "$VOL" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

log() { echo "[run-one] $*" >&2; }

docker volume create "$VOL" >/dev/null

# 1. Seed HERMES_HOME: /init writes config.yaml + syncs bundled skills, then we
#    set the one knob that is config-only (memory on/off).
log "seeding config (memory_enabled=$MEMORY) ..."
docker run --rm -e HERMES_UID=10000 -e HERMES_GID=10000 -v "$VOL":/opt/data \
  "$IMAGE" config set memory.memory_enabled "$MEMORY" >/dev/null 2>&1

# 2. Create (not yet start) the trial container, then copy our custom skill into
#    the seeded skills dir so `-s $SKILL` can resolve it.
log "creating trial container ..."
CID="$(docker create \
  -e GEMINI_API_KEY -e HERMES_UID=10000 -e HERMES_GID=10000 \
  -v "$VOL":/opt/data \
  "$IMAGE" \
  chat -q "$PROMPT" --oneshot \
       --provider "$PROVIDER" -m "$MODEL" \
       -t "$TOOLSETS" -s "$SKILL" \
       --yolo --max-turns "$MAX_TURNS")"

# docker cp's SOURCE is a host path. With MSYS_NO_PATHCONV=1 (needed so the
# ":/opt/data" mount targets aren't mangled), a Git-Bash "/d/..." source reaches
# the Windows docker.exe un-translated and fails — so convert just this source
# to a native path via cygpath when available.
to_host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
if [[ -d "$SCRIPT_DIR/skills/$SKILL" ]]; then
  docker cp "$(to_host_path "$SCRIPT_DIR/skills/$SKILL")" "$CID":/opt/data/skills/ >/dev/null
fi

# 3. Run the trial. Agent/s6 chatter goes to stderr; stdout stays clean.
log "running trial: model=$MODEL toolsets=$TOOLSETS skill=$SKILL ..."
docker start -a "$CID" >&2 || true

# 4. Parse the resulting state.db into the JSON contract (read-only). Runs in a
#    fresh container over the same volume; the trial container has exited, so
#    the DB is quiescent.
log "inspecting state.db ..."
docker run --rm -i -v "$VOL":/opt/data --entrypoint python3 "$IMAGE" \
  -I - /opt/data/state.db < "$SCRIPT_DIR/inspect_statedb.py" 2>/dev/null

log "done (volume=$VOL${KEEP:+ kept})"
