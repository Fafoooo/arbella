/**
 * OS abstraction. The ONE place that touches node:os / node:process for paths.
 * Never hardcode home or config paths anywhere else — call these helpers so the
 * tool works identically on macOS, Linux, and Windows.
 */

import os from "node:os";
import path from "node:path";
import process from "node:process";

import type { EnvVars, OS, ToolId } from "../types.js";

/** Detect the current platform, narrowed to the OSes arbella supports. */
export function detectOS(): OS {
  const p = process.platform;
  if (p === "darwin") return "darwin";
  if (p === "win32") return "win32";
  // Treat every other POSIX platform as linux for install/path purposes.
  return "linux";
}

/** Absolute path to the user's home directory. */
export function homeDir(): string {
  return os.homedir();
}

/** Current username (best-effort; falls back to a parsed home basename). */
export function userName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return path.basename(homeDir());
  }
}

/**
 * Directory for arbella's own config (config.json lives here).
 *   - win32:        %APPDATA%/arbella  (or ~/AppData/Roaming/arbella)
 *   - darwin/linux: $XDG_CONFIG_HOME/arbella or ~/.config/arbella
 */
export function configDir(): string {
  if (detectOS() === "win32") {
    const appData = process.env.APPDATA ?? path.join(homeDir(), "AppData", "Roaming");
    return path.join(appData, "arbella");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(homeDir(), ".config");
  return path.join(xdg, "arbella");
}

/**
 * Directory for arbella's local data (default backup-repo clone location).
 *   - win32:        %LOCALAPPDATA%/arbella or ~/AppData/Local/arbella
 *   - darwin/linux: $XDG_DATA_HOME/arbella or ~/.local/share/arbella
 */
export function dataDir(): string {
  if (detectOS() === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(homeDir(), "AppData", "Local");
    return path.join(localAppData, "arbella");
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(homeDir(), ".local", "share");
  return path.join(xdg, "arbella");
}

/** Absolute path to a tool's home directory on this machine. */
export function toolHomeDir(tool: ToolId): string {
  switch (tool) {
    case "claude":
      return path.join(homeDir(), ".claude");
    case "codex":
      return path.join(homeDir(), ".codex");
    case "cursor":
      return path.join(homeDir(), ".cursor");
  }
}

/**
 * Root directory used by Electron/VS Code-style desktop apps for user config.
 * Cursor's User data lives below this root.
 */
export function appUserConfigRoot(targetOS: OS, userHome: string, env: EnvVars = {}): string {
  if (targetOS === "darwin") {
    return path.join(userHome, "Library", "Application Support");
  }
  if (targetOS === "win32") {
    return env.APPDATA ?? path.join(userHome, "AppData", "Roaming");
  }
  return env.XDG_CONFIG_HOME ?? path.join(userHome, ".config");
}

/* -------------------------------------------------------------------------- */
/* CLI install command mapping (R6)                                            */
/* -------------------------------------------------------------------------- */

/** A single shell command to run (program + args), OS-resolved. */
export interface InstallCommand {
  /** Executable, e.g. "npm", "brew", "winget". */
  cmd: string;
  /** Arguments array (never shell-joined to avoid injection). */
  args: string[];
}

/* -------------------------------------------------------------------------- */
/* Linux package manager detection (R6 cross-OS installs)                      */
/* -------------------------------------------------------------------------- */

/**
 * The Linux package managers arbella can drive for system tools (git, gh, glab).
 * `unknown` means none of the supported managers were found on PATH, in which
 * case the install layer degrades to a clear "install it manually" message.
 */
export type LinuxPackageManager = "apt" | "dnf" | "yum" | "pacman" | "zypper" | "unknown";

/**
 * Candidate manager executables in priority order. Debian/Ubuntu (`apt-get`)
 * first as it's the most common target, then Fedora/RHEL (`dnf`, legacy `yum`),
 * Arch (`pacman`), and openSUSE (`zypper`). The detector probes PATH for each and
 * returns the first present — this is the ONLY heuristic for "which distro".
 */
const LINUX_PM_PROBES: ReadonlyArray<{ id: LinuxPackageManager; bin: string }> = [
  { id: "apt", bin: "apt-get" },
  { id: "dnf", bin: "dnf" },
  { id: "yum", bin: "yum" },
  { id: "pacman", bin: "pacman" },
  { id: "zypper", bin: "zypper" },
];

/**
 * The executable that drives a given Linux package manager (e.g. `apt` -> the
 * `apt-get` binary). Returns null for `unknown`. Exposed so the install layer can
 * `which`-probe managers without re-encoding the apt->apt-get mapping.
 */
export function linuxPackageManagerBinary(pm: LinuxPackageManager): string | null {
  switch (pm) {
    case "apt":
      return "apt-get";
    case "dnf":
      return "dnf";
    case "yum":
      return "yum";
    case "pacman":
      return "pacman";
    case "zypper":
      return "zypper";
    case "unknown":
      return null;
  }
}

/**
 * The ordered list of (manager id, driving binary) candidates to probe on Linux.
 * The install layer iterates this with its PATH probe to pick the first present
 * manager; kept here so os.ts stays the single source of OS/package-manager
 * knowledge. (No I/O here — probing belongs to the install layer.)
 */
export function linuxPackageManagerCandidates(): ReadonlyArray<{
  id: LinuxPackageManager;
  bin: string;
}> {
  return LINUX_PM_PROBES;
}

/**
 * Build the argv that installs a single distro package non-interactively with a
 * given manager. Returns the program + args, ready for `sudo` prefixing by the
 * caller (system package managers need root; npm/brew/winget do not).
 *
 *   apt    -> apt-get install -y <pkg>
 *   dnf    -> dnf install -y <pkg>
 *   yum    -> yum install -y <pkg>
 *   pacman -> pacman -S --noconfirm <pkg>
 *   zypper -> zypper install -y <pkg>
 *
 * Returns null for `unknown` (no supported manager). `-y`/`--noconfirm` keep the
 * install non-interactive so a restore on a fresh box does not hang on a prompt.
 */
export function linuxInstallArgs(
  pm: LinuxPackageManager,
  pkg: string,
): { cmd: string; args: string[] } | null {
  switch (pm) {
    case "apt":
      return { cmd: "apt-get", args: ["install", "-y", pkg] };
    case "dnf":
      return { cmd: "dnf", args: ["install", "-y", pkg] };
    case "yum":
      return { cmd: "yum", args: ["install", "-y", pkg] };
    case "pacman":
      return { cmd: "pacman", args: ["-S", "--noconfirm", pkg] };
    case "zypper":
      return { cmd: "zypper", args: ["install", "-y", pkg] };
    case "unknown":
      return null;
  }
}

/**
 * Map a tool -> the command that installs its CLI/app on the given OS.
 * Returns null when there is no supported install path for that tool on that OS
 * (caller should warn + skip gracefully).
 *
 *   claude:  npm i -g @anthropic-ai/claude-code     (all OSes)
 *   codex:   npm i -g @openai/codex                 (all OSes)
 *   cursor:  brew install --cask cursor (darwin),   winget install ... (win32),
 *            no headless install on linux (null)    -- it's a desktop app.
 */
export function installCommandFor(tool: ToolId, targetOS: OS): InstallCommand | null {
  switch (tool) {
    case "claude":
      return { cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] };
    case "codex":
      return { cmd: "npm", args: ["install", "-g", "@openai/codex"] };
    case "cursor":
      if (targetOS === "darwin") {
        return { cmd: "brew", args: ["install", "--cask", "cursor"] };
      }
      if (targetOS === "win32") {
        return { cmd: "winget", args: ["install", "--id", "Anysphere.Cursor", "-e"] };
      }
      return null; // No standard headless install on Linux.
  }
}

/**
 * The probe used to check whether a tool's CLI is on PATH. Returns the binary
 * name to look up with `command -v` / `where`.
 */
export function cliBinaryName(tool: ToolId): string {
  switch (tool) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
  }
}
