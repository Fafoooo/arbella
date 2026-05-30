/**
 * Unit tests for the auth DECISION LOGIC — the orchestration in
 * src/core/auth/index.ts (`ensureRepoAuth` + `login`).
 *
 * This is the headline behavior of the auth task: gh/glab-FIRST, with an
 * install-on-demand step, degrading to arbella's own device-flow / token-paste
 * fallback. We drive the REAL orchestrator against mocked seams so the actual
 * branching runs (no logic is re-implemented in the test):
 *
 *   - `execa`                      mocked -> drives `gh/glab auth status|login`.
 *   - `src/platform/install.js`    `isInstalled` mocked (CLI present/absent).
 *   - `globalThis.fetch`           spied -> drives the device flow (NO network).
 *   - injected `installer`/`paste` seams supplied per-test (the command layer's job).
 *   - data dir redirected to a temp dir so any stored token is isolated.
 *
 * Decision matrix covered:
 *   - CLI present + logged-in            -> useProviderCli (NO token in arbella).
 *   - CLI present + NOT logged-in        -> triggers `<cli> auth login`; on success
 *                                            -> useProviderCli.
 *   - CLI missing                        -> install-prompt path: confirm + install,
 *                                            then login -> useProviderCli.
 *   - install declined / CLI unavailable -> device-flow fallback (client_id set),
 *                                            else token-paste fallback.
 *   - device-flow access_denied          -> no token stored, no paste re-prompt.
 *   - non-interactive                    -> never prompts; reports "needs auth".
 *   - ssh / non-https remote             -> needsAuth:false (untouched).
 *
 * And the HARD security guarantee: across every fallback that mints a token, the
 * token NEVER appears in logged output (logger writes to stderr; we capture it
 * with --verbose on so even debug lines are checked).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

/* -------------------------------------------------------------------------- */
/* Mocks (hoisted): execa + platform install detection                         */
/* -------------------------------------------------------------------------- */

interface ExecaResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  throws?: Error;
}

const execaState: {
  queue: ExecaResult[];
  calls: Array<{ file: string; args: string[] }>;
} = { queue: [], calls: [] };

vi.mock("execa", () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    execaState.calls.push({ file, args });
    const next = execaState.queue.shift() ?? { exitCode: 0 };
    if (next.throws) throw next.throws;
    return {
      exitCode: next.exitCode ?? 0,
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? "",
    };
  }),
}));

const installed: Record<string, boolean> = { gh: false, glab: false };

vi.mock("../../src/platform/install.js", () => ({
  isInstalled: vi.fn(async (id: string) => installed[id] === true),
}));

import {
  ensureRepoAuth,
  login,
  getCredential,
  providerById,
  type CliInstaller,
  type TokenPaster,
} from "../../src/core/auth/index.js";
import { setVerbose } from "../../src/utils/log.js";

/* -------------------------------------------------------------------------- */
/* Env redirection (isolate the credential store) + stderr capture             */
/* -------------------------------------------------------------------------- */

let tmpRoot: string;
let homeSpy: MockInstance;
let stderrSpy: MockInstance;
let stderrChunks: string[];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "arbella-auth-"));
  for (const k of [
    "XDG_DATA_HOME",
    "LOCALAPPDATA",
    "HOME",
    "USERPROFILE",
    "ARBELLA_GITHUB_CLIENT_ID",
    "ARBELLA_GITLAB_CLIENT_ID",
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.XDG_DATA_HOME = path.join(tmpRoot, "xdg-data");
  process.env.LOCALAPPDATA = path.join(tmpRoot, "localappdata");
  process.env.HOME = tmpRoot;
  process.env.USERPROFILE = tmpRoot;
  // Device flow is OFF by default unless a test opts in by setting a client_id.
  delete process.env.ARBELLA_GITHUB_CLIENT_ID;
  delete process.env.ARBELLA_GITLAB_CLIENT_ID;

  homeSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpRoot);

  // Capture EVERYTHING the logger writes (it writes to stderr). Verbose ON so
  // even debug lines are subject to the "no token" assertions.
  stderrChunks = [];
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  setVerbose(true);

  execaState.queue = [];
  execaState.calls = [];
  installed.gh = false;
  installed.glab = false;
});

afterEach(() => {
  setVerbose(false);
  stderrSpy.mockRestore();
  homeSpy.mockRestore();
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Note: tmpRoot is left for the OS to reap; each test uses a fresh mkdtemp.
});

/** All captured stderr text joined (what the user/logger would have seen). */
function loggedText(): string {
  return stderrChunks.join("");
}

const REPO_URL = "https://github.com/me/backup.git";

/* -------------------------------------------------------------------------- */
/* Non-https remotes are untouched                                             */
/* -------------------------------------------------------------------------- */

describe("ensureRepoAuth: non-https remotes need no auth", () => {
  it("returns needsAuth:false for ssh and file remotes (used as-is)", async () => {
    const ssh = await ensureRepoAuth({ repoUrl: "git@github.com:me/backup.git" });
    expect(ssh.needsAuth).toBe(false);
    expect(ssh.authUrl).toBeUndefined();

    const file = await ensureRepoAuth({ repoUrl: "file:///srv/git/backup.git" });
    expect(file.needsAuth).toBe(false);

    // No CLI was probed and no process spawned for a non-credential remote.
    expect(execaState.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* CLI present + logged in -> useProviderCli                                    */
/* -------------------------------------------------------------------------- */

describe("ensureRepoAuth: provider CLI present and logged in", () => {
  it("uses the provider CLI (no token in arbella, original URL kept)", async () => {
    installed.gh = true;
    execaState.queue = [{ exitCode: 0, stderr: "Logged in to github.com as octocat" }];

    const auth = await ensureRepoAuth({ repoUrl: REPO_URL, interactive: true });

    expect(auth.needsAuth).toBe(true);
    expect(auth.useProviderCli).toBe(true);
    expect(auth.cli).toBe("gh");
    expect(auth.provider).toBe("github");
    // No arbella-token URL is produced on the CLI path.
    expect(auth.authUrl).toBeUndefined();
    // Nothing was stored in arbella's vault.
    expect(await getCredential("github.com")).toBeUndefined();
    // Only an `auth status` probe ran — no `auth login`.
    expect(execaState.calls.every((c) => !c.args.includes("login"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* CLI present + NOT logged in -> triggers login                               */
/* -------------------------------------------------------------------------- */

describe("ensureRepoAuth: provider CLI present but logged out", () => {
  it("runs `<cli> auth login`, then (on success) uses the provider CLI", async () => {
    installed.gh = true;
    execaState.queue = [
      { exitCode: 1, stderr: "You are not logged in to any GitHub hosts" }, // status #1
      { exitCode: 0 }, // `gh auth login` succeeds
      { exitCode: 0, stderr: "Logged in to github.com" }, // re-verify status
    ];

    const auth = await ensureRepoAuth({ repoUrl: REPO_URL, interactive: true });

    expect(auth.useProviderCli).toBe(true);
    expect(auth.cli).toBe("gh");
    // An `auth login` was actually attempted (the decisive behavior).
    expect(execaState.calls.some((c) => c.args.includes("login"))).toBe(true);
    expect(await getCredential("github.com")).toBeUndefined();
  });

  it("falls back when the login is cancelled and nothing else is available", async () => {
    installed.gh = true;
    execaState.queue = [
      { exitCode: 1, stderr: "not logged in" }, // status
      { throws: new Error("login cancelled (exit 1)") }, // `gh auth login` fails
    ];
    // No client_id (device flow off) and no paste seam -> no fallback possible.
    const auth = await ensureRepoAuth({ repoUrl: REPO_URL, interactive: true });

    expect(auth.useProviderCli).toBeUndefined();
    expect(auth.authUrl).toBeUndefined();
    expect(auth.needsAuth).toBe(true); // reported, with no usable credential
  });
});

/* -------------------------------------------------------------------------- */
/* CLI missing -> install-prompt path                                          */
/* -------------------------------------------------------------------------- */

describe("ensureRepoAuth: provider CLI missing -> install-on-demand", () => {
  it("offers to install gh; on accept+install it logs in and uses the CLI", async () => {
    installed.gh = false; // gh absent at first

    // The installer seam: confirm -> yes, install -> flips gh to installed.
    const confirm = vi.fn(async () => true);
    const installer: CliInstaller = {
      confirm,
      install: vi.fn(async (dep) => {
        installed.gh = true; // now present
        return { id: dep, status: "installed" as const };
      }),
    };

    // After install: status says logged out -> login succeeds -> re-verify ok.
    execaState.queue = [
      { exitCode: 1, stderr: "not logged in" }, // status (post-install)
      { exitCode: 0 }, // `gh auth login`
      { exitCode: 0, stderr: "Logged in to github.com" }, // re-verify
    ];

    const auth = await ensureRepoAuth({ repoUrl: REPO_URL, interactive: true, installer });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(installer.install).toHaveBeenCalledWith("gh");
    expect(auth.useProviderCli).toBe(true);
    expect(auth.cli).toBe("gh");
  });

  it("declined install + device flow configured -> device-flow fallback stores a token", async () => {
    installed.gh = false;
    process.env.ARBELLA_GITHUB_CLIENT_ID = "real-client-id"; // device flow ON

    // User declines installing gh.
    const installer: CliInstaller = {
      confirm: vi.fn(async () => false),
      install: vi.fn(async (dep) => ({ id: dep, status: "installed" as const })),
    };

    // Device flow: scripted global fetch -> code issued, then immediate success.
    const DEVICE_TOKEN = "gho_DEVICE_FLOW_TOKEN_SECRET_zzz999";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeDeviceFlowFetch(DEVICE_TOKEN),
    );

    const auth = await ensureRepoAuth({ repoUrl: REPO_URL, interactive: true, installer });

    expect(installer.install).not.toHaveBeenCalled(); // declined
    expect(fetchSpy).toHaveBeenCalled(); // device flow ran
    expect(auth.useProviderCli).toBeUndefined();
    expect(auth.source).toBe("device-flow");
    // The fallback produced a token-embedded URL (oauth2:<token>@host).
    expect(auth.authUrl).toBe(`https://oauth2:${DEVICE_TOKEN}@github.com/me/backup.git`);
    // ...and stored it locally (0600 vault), keyed by host.
    const stored = await getCredential("github.com");
    expect(stored?.token).toBe(DEVICE_TOKEN);
    expect(stored?.source).toBe("device-flow");

    // HARD: the token never appears in any logged line.
    expect(loggedText()).not.toContain(DEVICE_TOKEN);
    expect(loggedText()).not.toContain("DEVICE_FLOW_TOKEN");

    fetchSpy.mockRestore();
  });

  it("declined install + NO device flow -> token-paste fallback stores a token", async () => {
    installed.gh = false; // no CLI
    // No client_id configured -> device flow unavailable -> paste path.

    const installer: CliInstaller = {
      confirm: vi.fn(async () => false), // decline install
      install: vi.fn(async (dep) => ({ id: dep, status: "installed" as const })),
    };

    const PASTED_TOKEN = "ghp_PASTED_PAT_SECRET_qqq111";
    const paste: TokenPaster = vi.fn(async () => PASTED_TOKEN);

    const auth = await ensureRepoAuth({
      repoUrl: REPO_URL,
      interactive: true,
      installer,
      paste,
    });

    expect(paste).toHaveBeenCalledTimes(1);
    expect(auth.source).toBe("token-paste");
    expect(auth.authUrl).toBe(`https://oauth2:${PASTED_TOKEN}@github.com/me/backup.git`);
    expect((await getCredential("github.com"))?.token).toBe(PASTED_TOKEN);

    // HARD: no token in logged output.
    expect(loggedText()).not.toContain(PASTED_TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* Device-flow refusal + non-interactive + unknown host                        */
/* -------------------------------------------------------------------------- */

describe("ensureRepoAuth: fallback edge cases", () => {
  it("a denied device flow does NOT fall through to a paste re-prompt", async () => {
    installed.gh = false;
    process.env.ARBELLA_GITHUB_CLIENT_ID = "real-client-id";

    // Device flow: code issued, then the user DENIES.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      makeDeviceFlowFetch(undefined, "access_denied"),
    );
    const paste: TokenPaster = vi.fn(async () => "ghp_SHOULD_NOT_BE_CALLED");

    const auth = await ensureRepoAuth({
      repoUrl: REPO_URL,
      interactive: true,
      paste,
      preferDeviceFlow: true, // go straight to arbella's engine
    });

    // Denied -> no token, and the paste prompt is NOT shown (a hard refusal).
    expect(paste).not.toHaveBeenCalled();
    expect(auth.authUrl).toBeUndefined();
    expect(auth.needsAuth).toBe(true);
    expect(await getCredential("github.com")).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it("non-interactive never prompts and reports 'needs auth'", async () => {
    installed.gh = true;
    execaState.queue = [{ exitCode: 1, stderr: "not logged in" }]; // logged out
    const paste: TokenPaster = vi.fn(async () => "ghp_NOPE");

    const auth = await ensureRepoAuth({ repoUrl: REPO_URL, interactive: false, paste });

    expect(auth.needsAuth).toBe(true);
    expect(auth.authUrl).toBeUndefined();
    expect(auth.useProviderCli).toBeUndefined();
    // It did NOT attempt an interactive login or a paste.
    expect(execaState.calls.some((c) => c.args.includes("login"))).toBe(false);
    expect(paste).not.toHaveBeenCalled();
  });

  it("an unknown host with a paste seam stores a pasted token (no provider CLI)", async () => {
    const SELF_HOSTED = "https://git.mycorp.example/team/backup.git";
    const PASTED = "selfhosted-PAT-SECRET-7777";
    const paste: TokenPaster = vi.fn(async () => PASTED);

    const auth = await ensureRepoAuth({ repoUrl: SELF_HOSTED, interactive: true, paste });

    expect(paste).toHaveBeenCalledTimes(1);
    expect(auth.source).toBe("token-paste");
    expect(auth.authUrl).toBe(`https://oauth2:${PASTED}@git.mycorp.example/team/backup.git`);
    // No gh/glab probe for an unknown host.
    expect(execaState.calls).toHaveLength(0);
    expect(loggedText()).not.toContain(PASTED);
  });

  it("reuses an already-stored token without probing the CLI", async () => {
    installed.gh = true; // even though gh is present + would-be checked...
    const SAVED = "gho_PREVIOUSLY_SAVED_TOKEN_5555";
    // Seed the store via a first paste run (unknown host avoids CLI), then assert
    // a second call reuses it. Simpler: store directly through a token-paste run.
    const firstPaste: TokenPaster = vi.fn(async () => SAVED);
    await ensureRepoAuth({
      repoUrl: REPO_URL,
      interactive: true,
      paste: firstPaste,
      preferDeviceFlow: true, // skip CLI; no client_id -> paste -> stores SAVED
    });
    execaState.calls = []; // reset the spawn log

    const again = await ensureRepoAuth({ repoUrl: REPO_URL, interactive: true });
    expect(again.authUrl).toBe(`https://oauth2:${SAVED}@github.com/me/backup.git`);
    expect(again.source).toBe("token-paste");
    // The stored-token short-circuit means NO CLI probe ran on the second call.
    expect(execaState.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* login() helper (arbella auth login)                                         */
/* -------------------------------------------------------------------------- */

describe("login(): provider-CLI first, fallback to device-flow/paste", () => {
  it("returns method 'provider-cli' when gh is present + logged in", async () => {
    installed.gh = true;
    execaState.queue = [{ exitCode: 0, stderr: "Logged in to github.com" }];

    const result = await login({ provider: providerById("github") });
    expect(result).not.toBeNull();
    expect(result!.method).toBe("provider-cli");
    expect(result!.provider).toBe("github");
    expect(result!.source).toBeUndefined(); // arbella stored nothing
  });

  it("returns method 'token-paste' when forced to arbella's engine with a paste seam", async () => {
    const TOKEN = "ghp_LOGIN_PASTE_TOKEN_4444";
    const paste: TokenPaster = vi.fn(async () => TOKEN);

    const result = await login({
      provider: providerById("github"),
      paste,
      preferDeviceFlow: true, // skip gh; no client_id -> paste
    });

    expect(result!.method).toBe("token-paste");
    expect(result!.source).toBe("token-paste");
    expect((await getCredential("github.com"))?.token).toBe(TOKEN);
    expect(loggedText()).not.toContain(TOKEN);
  });

  it("returns null when nothing can sign in (no CLI, no device flow, no paste)", async () => {
    installed.gh = false;
    const result = await login({ provider: providerById("github") });
    expect(result).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Helper: a scripted device-flow fetch (NO real network)                      */
/* -------------------------------------------------------------------------- */

/**
 * Build a fake global `fetch` that drives the device flow: the FIRST POST (device
 * authorization) returns a code; the SECOND (token poll) returns either the
 * access token (`token`) or an OAuth error (`errorCode`, e.g. "access_denied").
 */
function makeDeviceFlowFetch(
  token: string | undefined,
  errorCode?: string,
): typeof fetch {
  let call = 0;
  return (async () => {
    call += 1;
    const body =
      call === 1
        ? {
            device_code: "DEV-XYZ",
            user_code: "ABCD-WXYZ",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          }
        : token
          ? { access_token: token, token_type: "bearer", scope: "repo" }
          : { error: errorCode ?? "authorization_pending" };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
}
