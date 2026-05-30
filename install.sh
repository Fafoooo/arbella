#!/usr/bin/env sh
#
# arbella installer — wraps `npm install -g arbella`.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Fafoooo/arbella/main/install.sh | sh
#
# This is an OPTIONAL convenience. It is exactly equivalent to running
# `npm install -g arbella` yourself; it only adds a friendly prerequisite check
# (Node.js + npm) and clear next steps. No secrets are read or written here.
#
# Override the package spec (e.g. a tag or version) via ARBELLA_PKG:
#   ARBELLA_PKG="arbella@latest" sh install.sh

set -eu

PKG="${ARBELLA_PKG:-arbella}"

info() { printf '%s\n' "arbella-install: $*"; }
err()  { printf '%s\n' "arbella-install: error: $*" >&2; }

# 1) Require Node.js (its presence implies a usable runtime for the CLI).
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed (or not on PATH)."
  err "Install Node.js >= 18 from https://nodejs.org/ and re-run this script."
  exit 1
fi

# 2) Require npm (ships with Node.js; this is how we install the package).
if ! command -v npm >/dev/null 2>&1; then
  err "npm is not installed (or not on PATH)."
  err "npm ships with Node.js — reinstall Node.js from https://nodejs.org/."
  exit 1
fi

info "Node $(node --version), npm $(npm --version) detected."
info "Installing ${PKG} globally (npm install -g ${PKG}) ..."

# 3) The actual install. Identical to documenting `npm i -g arbella`.
if ! npm install -g "${PKG}"; then
  err "npm install -g ${PKG} failed."
  err "If this is a permissions error, configure an npm prefix you own"
  err "(see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)"
  err "or re-run with elevated privileges."
  exit 1
fi

info "Done. The 'arbella' command is now available."
info "Next: run 'arbella init' to connect your private backup repo."
