/**
 * Unit tests for the provider-CLI bridge (src/core/auth/cli.ts) — arbella's
 * PREFERRED auth path (gh / glab).
 *
 * NO REAL SPAWN: both seams the bridge uses are mocked —
 *   - `execa` (the process spawner) is replaced by a controllable fake whose
 *     queued results drive `<cli> auth status|login|logout`;
 *   - `src/platform/install.js`'s `isInstalled` is mocked so we can flip the CLI
 *     between "absent" and "present" without touching PATH.
 *
 * What's proven:
 *   - presence/login classification: `providerCliAuthStatus` -> "absent" when not
 *     installed, "authenticated" on exit 0, "not-authenticated" on a "not logged
 *     in" report, "unknown" on an unclassifiable failure.
 *   - login: returns true on exit 0, false on a non-zero/cancelled exit, and
 *     SPAWNS WITH INHERITED STDIO (the security crux: the token goes straight into
 *     gh/glab's own store and never passes through arbella).
 *   - the `auth status` probe runs NON-interactively (stdin ignored, output piped)
 *     and the CLI's (possibly token-hinting) stderr is never echoed to the user.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------- */
/* Mocks (hoisted): execa + platform install detection                         */
/* -------------------------------------------------------------------------- */

/** Queue of scripted execa results + a record of every invocation. */
interface ExecaResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  throws?: Error; // when set, the call rejects (spawn failure)
}

const execaState: {
  queue: ExecaResult[];
  calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }>;
} = { queue: [], calls: [] };

vi.mock("execa", () => ({
  execa: vi.fn(
    async (file: string, args: string[] = [], options: Record<string, unknown> = {}) => {
      execaState.calls.push({ file, args, options });
      const next = execaState.queue.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
      if (next.throws) throw next.throws;
      return {
        exitCode: next.exitCode ?? 0,
        stdout: next.stdout ?? "",
        stderr: next.stderr ?? "",
      };
    },
  ),
}));

/** CLI-presence map the mocked isInstalled consults. */
const installed: Record<string, boolean> = { gh: false, glab: false };

vi.mock("../../src/platform/install.js", () => ({
  // cli.ts: isProviderCliInstalled -> isInstalled(dependencyId) where the id is
  // "gh" / "glab". Resolve against the controllable map.
  isInstalled: vi.fn(async (id: string) => installed[id] === true),
}));

// Import AFTER the mocks are registered (vi.mock is hoisted, but keep it explicit).
import {
  cliForProvider,
  isProviderCliAuthenticated,
  isProviderCliInstalled,
  providerCliAuthStatus,
  providerCliLogin,
  providerCliLogout,
} from "../../src/core/auth/cli.js";

/* -------------------------------------------------------------------------- */
/* Per-test reset                                                              */
/* -------------------------------------------------------------------------- */

beforeEach(() => {
  execaState.queue = [];
  execaState.calls = [];
  installed.gh = false;
  installed.glab = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Mapping                                                                      */
/* -------------------------------------------------------------------------- */

describe("auth cli: provider -> CLI mapping", () => {
  it("maps github/gitlab to gh/glab with the installer dependency id", () => {
    expect(cliForProvider("github")).toMatchObject({ bin: "gh", dependency: "gh" });
    expect(cliForProvider("gitlab")).toMatchObject({ bin: "glab", dependency: "glab" });
  });
});

/* -------------------------------------------------------------------------- */
/* Detection + status classification                                           */
/* -------------------------------------------------------------------------- */

describe("auth cli: presence + login-state classification", () => {
  it("reports 'absent' (and never spawns) when the CLI is not installed", async () => {
    installed.gh = false;
    expect(await isProviderCliInstalled("github")).toBe(false);
    expect(await providerCliAuthStatus("github")).toBe("absent");
    // No `gh` process was spawned for a known-absent CLI.
    expect(execaState.calls).toHaveLength(0);
  });

  it("reports 'authenticated' on exit 0 and runs the probe non-interactively", async () => {
    installed.gh = true;
    execaState.queue = [
      { exitCode: 0, stderr: "github.com\n  ✓ Logged in to github.com as octocat" },
    ];

    expect(await providerCliAuthStatus("github", "github.com")).toBe("authenticated");

    // The probe ran `gh auth status --hostname github.com` with stdin ignored and
    // output captured (NOT inherited — its stderr can hint at a token and must
    // never reach the user's terminal).
    const call = execaState.calls[0]!;
    expect(call.file).toBe("gh");
    expect(call.args).toEqual(["auth", "status", "--hostname", "github.com"]);
    expect(call.options.stdin).toBe("ignore");
    expect(call.options.stdout).toBe("pipe");
    expect(call.options.stderr).toBe("pipe");
    expect(call.options.stdio).not.toBe("inherit");
  });

  it("reports 'not-authenticated' when the report says 'not logged in'", async () => {
    installed.glab = true;
    execaState.queue = [{ exitCode: 1, stderr: "You are not logged in to gitlab.com" }];
    expect(await providerCliAuthStatus("gitlab")).toBe("not-authenticated");
  });

  it("reports 'unknown' on an unclassifiable non-zero report", async () => {
    installed.gh = true;
    execaState.queue = [{ exitCode: 2, stderr: "some unrelated transient error" }];
    expect(await providerCliAuthStatus("github")).toBe("unknown");
  });

  it("reports 'unknown' when the status spawn itself throws", async () => {
    installed.gh = true;
    execaState.queue = [{ throws: new Error("spawn gh ENOENT") }];
    expect(await providerCliAuthStatus("github")).toBe("unknown");
  });

  it("isProviderCliAuthenticated is true only for an exit-0 status", async () => {
    installed.gh = true;
    execaState.queue = [{ exitCode: 0, stderr: "Logged in to github.com" }];
    expect(await isProviderCliAuthenticated("github")).toBe(true);

    execaState.queue = [{ exitCode: 1, stderr: "not logged in" }];
    expect(await isProviderCliAuthenticated("github")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Login (inherited stdio is the security crux)                                */
/* -------------------------------------------------------------------------- */

describe("auth cli: login spawns with inherited stdio", () => {
  it("returns true on exit 0 and hands the terminal to gh (stdio: inherit)", async () => {
    installed.gh = true;
    execaState.queue = [{ exitCode: 0 }]; // the login process succeeds

    const ok = await providerCliLogin("github", { host: "github.com" });
    expect(ok).toBe(true);

    const call = execaState.calls[0]!;
    expect(call.file).toBe("gh");
    // gh login over https with the browser/device flow.
    expect(call.args).toContain("auth");
    expect(call.args).toContain("login");
    expect(call.args).toContain("--hostname");
    expect(call.args).toContain("github.com");
    expect(call.args).toContain("--git-protocol");
    expect(call.args).toContain("https");
    expect(call.args).toContain("--web");
    // SECURITY: inherited stdio means the token never flows through arbella.
    expect(call.options.stdio).toBe("inherit");
  });

  it("returns false when the login process exits non-zero (user cancelled)", async () => {
    installed.glab = true;
    execaState.queue = [{ throws: new Error("Command failed with exit code 1") }];

    const ok = await providerCliLogin("gitlab");
    expect(ok).toBe(false);

    const call = execaState.calls[0]!;
    expect(call.file).toBe("glab");
    expect(call.args.slice(0, 2)).toEqual(["auth", "login"]);
    expect(call.options.stdio).toBe("inherit");
  });

  it("returns false WITHOUT spawning when the CLI is not installed", async () => {
    installed.gh = false;
    const ok = await providerCliLogin("github");
    expect(ok).toBe(false);
    expect(execaState.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Logout                                                                       */
/* -------------------------------------------------------------------------- */

describe("auth cli: logout", () => {
  it("runs `<cli> auth logout` with inherited stdio when installed", async () => {
    installed.gh = true;
    execaState.queue = [{ exitCode: 0 }];
    const ok = await providerCliLogout("github", "github.com");
    expect(ok).toBe(true);
    const call = execaState.calls[0]!;
    expect(call.file).toBe("gh");
    expect(call.args).toEqual(["auth", "logout", "--hostname", "github.com"]);
    expect(call.options.stdio).toBe("inherit");
  });

  it("is a no-op (false, no spawn) when the CLI is not installed", async () => {
    installed.glab = false;
    expect(await providerCliLogout("gitlab")).toBe(false);
    expect(execaState.calls).toHaveLength(0);
  });
});
