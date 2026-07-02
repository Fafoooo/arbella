/**
 * All Google Antigravity path knowledge for the arbella antigravity adapter.
 *
 * Antigravity is a VS Code / Electron-fork IDE (bundle id com.google.antigravity)
 * that also ships a launcher CLI (`antigravity`, alias `agy`). Its portable setup
 * is split across THREE roots, every one resolved from the OS abstraction (never
 * hardcoded) so it is correct on macOS, Linux, and Windows:
 *
 *   1. HOME dotfolder  ~/.antigravity                     -> repo `antigravity/files`
 *        Freezes only extensions/extensions.json (the installed-extension
 *        manifest). Extension binaries and argv.json (which carries a machine
 *        crash-reporter id) are NOT listed, so they are never captured.
 *   2. USER data dir   <appUserConfigRoot>/Antigravity/User  -> repo `antigravity/user`
 *        (macOS ~/Library/Application Support, Linux ~/.config, Windows %APPDATA%)
 *        Freezes settings.json, keybindings.json, snippets/ (editor + agent prefs).
 *   3. GEMINI dir      ~/.gemini                          -> repo `antigravity/gemini`
 *        Freezes GEMINI.md (global rules), settings.json, antigravity/mcp_config.json,
 *        and skills/. This dir is SHARED with the Gemini CLI and also holds live
 *        Google OAuth secrets (oauth_creds.json, google_accounts.json, ...). Those
 *        are NEVER in the frozen allowlist and are hard-denied for defense in depth,
 *        so no credential can reach the repo.
 *
 * The tool home passed to capture()/restore() is the ~/.antigravity dotfolder; the
 * USER and GEMINI roots are derived from its parent (the user home), exactly as the
 * Cursor adapter derives Cursor's VS Code User dir. All sub-paths are built with
 * node:path.join so separators are correct on win32; the repoPath prefixes are
 * POSIX-only literals used inside the backup repo.
 */

import path from "node:path";

import type { EnvVars, OS } from "../../types.js";
import { appUserConfigRoot, toolHomeDir } from "../../platform/os.js";

/** Absolute path to ~/.antigravity on this machine. */
export function home(): string {
  return toolHomeDir("antigravity");
}

/** Repo prefixes for the three roots (POSIX literals inside the backup repo). */
export const HOME_REPO_PREFIX = "antigravity/files";
export const USER_REPO_PREFIX = "antigravity/user";
export const GEMINI_REPO_PREFIX = "antigravity/gemini";

/**
 * Files/dirs to FREEZE per root, relative to that root, in capture order. Missing
 * paths are skipped gracefully; anything matching the denylist is dropped even if
 * listed here. The lists are deliberately narrow ALLOWLISTS — the sensitive dir
 * (~/.gemini) yields ONLY these user-authored files, so OAuth/state never surface.
 */
export const HOME_FROZEN_PATHS: readonly string[] = ["extensions/extensions.json"] as const;
export const USER_FROZEN_PATHS: readonly string[] = [
  "settings.json",
  "keybindings.json",
  "snippets",
] as const;
export const GEMINI_FROZEN_PATHS: readonly string[] = [
  "GEMINI.md",
  "settings.json",
  "antigravity/mcp_config.json",
  "skills",
] as const;

/**
 * App-folder names Antigravity has shipped under, in PREFERENCE order. The 2.0
 * update (May 2026) split the product on Windows: the restored classic IDE is
 * "Antigravity IDE" (settings under %APPDATA%\Antigravity IDE, extensions under
 * ~/.antigravity-ide) while other installs — verified live on macOS 2.0.6 — keep
 * the original "Antigravity" (+ ~/.antigravity). Both exist in the wild, so the
 * adapter probes candidates and prefers the one present (IDE-variant first: when
 * both exist, a migrated machine's live data is the IDE one); the classic name
 * stays the default when neither exists.
 */
export const ANTIGRAVITY_APP_DIR_NAMES: readonly string[] = ["Antigravity IDE", "Antigravity"];
export const ANTIGRAVITY_DOTFOLDER_NAMES: readonly string[] = [".antigravity-ide", ".antigravity"];

/**
 * The VS Code-style application User data dir for Antigravity, per OS — the
 * DEFAULT (classic "Antigravity") location. Derived from the tool home's parent
 * (the user home) so tests can point the tool home at a fixture dir and the User
 * dir resolves alongside it. Callers that can probe the filesystem should use
 * antigravityUserDirCandidates() and prefer an existing dir.
 */
export function antigravityUserDir(toolHome: string, os: OS, env: EnvVars = {}): string {
  const userHome = path.dirname(toolHome);
  return path.join(appUserConfigRoot(os, userHome, env), "Antigravity", "User");
}

/** All candidate User data dirs, in preference order (IDE-variant first). */
export function antigravityUserDirCandidates(
  toolHome: string,
  os: OS,
  env: EnvVars = {},
): string[] {
  const userHome = path.dirname(toolHome);
  return ANTIGRAVITY_APP_DIR_NAMES.map((name) =>
    path.join(appUserConfigRoot(os, userHome, env), name, "User"),
  );
}

/** All candidate dotfolder homes, in preference order (IDE-variant first). */
export function antigravityHomeCandidates(toolHome: string): string[] {
  const userHome = path.dirname(toolHome);
  return ANTIGRAVITY_DOTFOLDER_NAMES.map((name) => path.join(userHome, name));
}

/** The shared ~/.gemini dir, derived from the tool home's parent. */
export function geminiDir(toolHome: string): string {
  return path.join(path.dirname(toolHome), ".gemini");
}
