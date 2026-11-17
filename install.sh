#!/usr/bin/env bash
# Browser-use installer.
#
#   bash install.sh                     install or upgrade the latest release
#   bash install.sh --version 0.4.1     install a specific version
#   bash install.sh --prefix ~/.local   install into a prefix you own
#   bash install.sh --dry-run           show the plan, change nothing
#   bash install.sh --no-doctor         skip the browser check
#
# Every stage reports what it is doing, how long it took, and whether it worked.
# Nothing is installed until the preflight checks pass.
set -uo pipefail

PACKAGE="lorde-browser-use"
MIN_NODE_MAJOR=20
REQUESTED_VERSION=""
PREFIX=""
DRY_RUN=0
RUN_DOCTOR=1
STAGE_TOTAL=6
LOG="$(mktemp 2>/dev/null || echo /tmp/browser-use-install.log)"

# ---------------------------------------------------------------- presentation
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; BLUE=$'\033[36m'
else
  B=""; DIM=""; R=""; GREEN=""; RED=""; YELLOW=""; BLUE=""
fi
WIDTH=$(tput cols 2>/dev/null || echo 72)
[ "$WIDTH" -gt 84 ] && WIDTH=84
[ "$WIDTH" -lt 40 ] && WIDTH=40

hr() { printf '%s\n' "${DIM}$(printf '─%.0s' $(seq 1 "$WIDTH"))${R}"; }
stage() { printf '\n%s[%s/%s]%s %s\n' "$BLUE" "$1" "$STAGE_TOTAL" "$R" "$2"; }
ok()    { printf '      %s✔%s %s\n' "$GREEN" "$R" "$1"; }
note()  { printf '      %s%s%s\n' "$DIM" "$1" "$R"; }
warn()  { printf '      %s!%s %s\n' "$YELLOW" "$R" "$1"; }
die() {
  printf '\n      %s✖ %s%s\n' "$RED" "$1" "$R"
  [ -n "${2:-}" ] && printf '        %s%s%s\n' "$DIM" "$2" "$R"
  printf '\n'
  exit 1
}

# Spinner that also reports elapsed time, so a long npm run never looks frozen.
spinner() {
  local label="$1" pid="$2" frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0 start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    local f="${frames:$((i % ${#frames})):1}"
    printf '\r      %s%s%s %s%s (%ss)%s' "$BLUE" "$f" "$R" "$label" "$DIM" "$((SECONDS - start))" "$R"
    i=$((i + 1)); sleep 0.1
  done
  printf '\r\033[K'
}

usage() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) REQUESTED_VERSION="${2:-}"; shift 2 ;;
    --prefix)  PREFIX="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-doctor) RUN_DOCTOR=0; shift ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1" "Run: bash install.sh --help" ;;
  esac
done

# ---------------------------------------------------------------- 1. preflight
printf '\n%s%s%s\n' "$B" "Browser-use installer" "$R"
note "browser agent, terminal interface and web interface in one package"
hr

stage 1 "Checking this machine"
command -v node >/dev/null 2>&1 || die "Node.js is not installed" "Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org, then run this again."
command -v npm  >/dev/null 2>&1 || die "npm is not available" "It normally ships with Node.js. Reinstall Node.js to restore it."
NODE_VERSION="$(node -v)"; NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null || die "Node.js ${NODE_VERSION} is too old" "This package needs ${MIN_NODE_MAJOR} or newer. Upgrade Node.js first."
ok "node ${NODE_VERSION}"
ok "npm $(npm -v)"
ok "$(uname -s) $(uname -m)"

# ---------------------------------------------------------------- 2. resolve
stage 2 "Resolving the package"
TARGET="${PACKAGE}@${REQUESTED_VERSION:-latest}"
note "registry: $(npm config get registry)"
RESOLVED="$(npm view "$TARGET" version 2>/dev/null | tail -1)"
if [ -z "$RESOLVED" ]; then
  die "Could not reach the npm registry" "Check your connection or proxy, then retry."
fi
ok "${PACKAGE} ${RESOLVED}"

CURRENT=""
if command -v browser-use >/dev/null 2>&1; then
  CURRENT="$(browser-use --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  [ -n "$CURRENT" ] && note "installed now: ${CURRENT}"
fi
if [ "$CURRENT" = "$RESOLVED" ]; then
  note "already at ${RESOLVED}, reinstalling to repair"
fi

TARGET_PREFIX="${PREFIX:-$(npm config get prefix 2>/dev/null)}"
note "install prefix: ${TARGET_PREFIX}"
note "log: ${LOG}"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n%sDry run: would install %s into %s%s\n\n' "$YELLOW" "$TARGET" "$TARGET_PREFIX" "$R"
  exit 0
fi

# ---------------------------------------------------------------- 3. install
stage 3 "Installing"
printf '' > "$LOG"
INSTALL_ARGS=(-g "$TARGET" --no-fund --no-audit)
[ -n "$PREFIX" ] && INSTALL_ARGS+=(--prefix "$PREFIX")

( npm install "${INSTALL_ARGS[@]}" >>"$LOG" 2>&1 ) &
NPM_PID=$!
spinner "fetching packages and linking commands" "$NPM_PID"
wait "$NPM_PID"; NPM_STATUS=$?

if [ "$NPM_STATUS" -ne 0 ]; then
  # A locked-down global prefix is the common case; retry into a user directory.
  if grep -qiE "EACCES|EPERM|permission denied" "$LOG"; then
    warn "the global prefix is not writable"
    FALLBACK="${HOME}/.local"
    note "retrying into ${FALLBACK}"
    ( npm install -g "$TARGET" --prefix "$FALLBACK" --no-fund --no-audit >>"$LOG" 2>&1 ) &
    NPM_PID=$!
    spinner "installing into ${FALLBACK}" "$NPM_PID"
    wait "$NPM_PID"; NPM_STATUS=$?
    if [ "$NPM_STATUS" -ne 0 ]; then
      printf '\n%sLast lines from npm:%s\n' "$DIM" "$R"
      tail -12 "$LOG" | sed 's/^/        /'
      die "Install failed" "Full log: ${LOG}"
    fi
    TARGET_PREFIX="$FALLBACK"
    export PATH="${FALLBACK}/bin:${PATH}"
    warn "add this to your shell profile: export PATH=\"${FALLBACK}/bin:\$PATH\""
  else
    printf '\n%sLast lines from npm:%s\n' "$DIM" "$R"
    tail -12 "$LOG" | sed 's/^/        /'
    die "Install failed" "Full log: ${LOG}"
  fi
fi
ok "installed in $((SECONDS))s"

# ---------------------------------------------------------------- 4. verify
stage 4 "Verifying the commands"
for bin in browser-use browser lorde; do
  if command -v "$bin" >/dev/null 2>&1; then ok "$bin on PATH"; else warn "$bin not on PATH yet"; fi
done
if command -v browser-use >/dev/null 2>&1; then
  REPORTED="$(browser-use --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ "$REPORTED" = "$RESOLVED" ]; then ok "version reports ${REPORTED}"; else warn "version reports ${REPORTED:-unknown}, expected ${RESOLVED}"; fi
else
  die "browser-use is installed but not on PATH" "Open a new terminal, or add ${TARGET_PREFIX}/bin to PATH."
fi

# ---------------------------------------------------------------- 5. doctor
if [ "$RUN_DOCTOR" -eq 1 ]; then
  stage 5 "Checking the browser it will drive"
  if command -v browser-use >/dev/null 2>&1; then
    browser-use doctor 2>&1 | grep -E "binary|cdp launch|platform" | sed 's/^ *//; s/^/      /'
    note "full report: browser-use doctor"
  else
    warn "skipped"
  fi
else
  stage 5 "Browser check skipped"
fi

# ---------------------------------------------------------------- 6. done
stage 6 "Ready"
printf '      %sStart with:%s\n' "$B" "$R"
printf '        browser-use              %s# terminal interface%s\n' "$DIM" "$R"
printf '        browser-use gui --open   %s# web interface, no desktop app%s\n' "$DIM" "$R"
printf '        browser-use doctor       %s# diagnostics%s\n' "$DIM" "$R"
printf '\n'
[ -s "$LOG" ] && note "install log: ${LOG}"
hr
printf '\n'
