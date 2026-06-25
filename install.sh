#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${PEEKMYAGENT_REPO_URL:-https://github.com/fengjikui/peekMyAgent-public.git}"
INSTALL_DIR="${PEEKMYAGENT_INSTALL_DIR:-$HOME/.peekmyagent/app}"
BIN_DIR="${PEEKMYAGENT_BIN_DIR:-$HOME/.local/bin}"
BIN_PATH="$BIN_DIR/peekmyagent"

info() {
  printf '\033[1;34m%s\033[0m\n' "$*"
}

warn() {
  printf '\033[1;33m%s\033[0m\n' "$*" >&2
}

fail() {
  printf '\033[1;31mpeekMyAgent install error:\033[0m %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

need_cmd git
need_cmd node

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 18 ? 0 : 1)' >/dev/null 2>&1; then
  fail "Node.js 18 or newer is required. Current version: $(node --version 2>/dev/null || echo unknown)"
fi

info "Installing peekMyAgent"
info "Repository: $REPO_URL"
info "Install dir: $INSTALL_DIR"

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing installation found. Updating..."
  git -C "$INSTALL_DIR" fetch --quiet origin
  git -C "$INSTALL_DIR" checkout --quiet main
  git -C "$INSTALL_DIR" pull --ff-only --quiet origin main
elif [ -e "$INSTALL_DIR" ]; then
  fail "$INSTALL_DIR already exists but is not a git repository. Move it away or set PEEKMYAGENT_INSTALL_DIR."
else
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

cat > "$BIN_PATH" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/bin/peekmyagent.mjs" "\$@"
EOF
chmod +x "$BIN_PATH"

info "Installed CLI shim: $BIN_PATH"

CURRENT_BIN="$(command -v peekmyagent 2>/dev/null || true)"
if [ "$CURRENT_BIN" != "$BIN_PATH" ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*)
      if [ -n "$CURRENT_BIN" ]; then
        warn "A different peekmyagent is currently first in PATH: $CURRENT_BIN"
        warn "The new shim was installed at: $BIN_PATH"
      fi
      ;;
    *)
      warn "$BIN_DIR is not in your PATH."
      warn "Add this to your shell profile, then restart the terminal:"
      warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
fi

"$BIN_PATH" --help >/dev/null

info "peekMyAgent installed successfully."
info "Try:"
info "  peekmyagent open"
info "  cd <your-project> && peekmyagent claude -c"
