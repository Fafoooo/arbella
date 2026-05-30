/**
 * Thin git wrapper over `execa`. The ONE place that shells out to `git`.
 *
 * Every function takes an absolute `cwd` (the backup repo's local working copy).
 * We always pass args as an array to `execa("git", [...], { cwd })` — never a
 * shell string — so there is no shell interpolation / injection surface.
 *
 * Error policy: a non-zero git exit THROWS, EXCEPT for
 * the functions documented to return a boolean (`isGitRepo`, `commit`,
 * `hasRemote`), where a clean boolean is the contract. Those use `reject:false`
 * and inspect the exit code instead of throwing.
 */

import { execa } from "execa";

import { log } from "../../utils/log.js";

/** Normalized result of a git invocation. */
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Environment forced on EVERY git invocation so git never blocks on an
 * interactive credential prompt. Git reads credential prompts from /dev/tty,
 * NOT stdin — so `stdin:"ignore"` is not enough; without this a private clone
 * hangs at `Username for 'https://…':`. `GIT_TERMINAL_PROMPT=0` makes a
 * missing-credential operation FAIL FAST instead, which the auth layer catches
 * (isAuthFailure) and then handles via gh/glab login or the device-flow/token
 * fallback. `GCM_INTERACTIVE=never` likewise silences Git Credential Manager.
 * A configured credential helper (e.g. gh's, after login) still supplies creds
 * normally — this only disables the interactive *fallback* prompt.
 */
const NONINTERACTIVE_GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
} as const;

/**
 * Run git in `cwd`. When `reject` is false the promise resolves even on a
 * non-zero exit so callers can branch on `exitCode` themselves.
 */
async function git(
  cwd: string,
  args: string[],
  opts: { reject?: boolean } = {},
): Promise<GitResult> {
  const reject = opts.reject ?? true;
  // Redact any credential embedded in a URL arg before logging, so a token can
  // never appear even at debug volume (defense-in-depth; the auth layer also
  // redacts before logging URLs it produces).
  log.debug(`git ${args.map(redactArg).join(" ")} (cwd=${cwd})`);
  let res;
  try {
    res = await execa("git", args, {
      cwd,
      reject,
      // Keep output as strings; do not inherit stdio so we can capture/redact.
      stdout: "pipe",
      stderr: "pipe",
      // git should never need stdin for the porcelain we run; closing it avoids
      // hangs on prompts (e.g. credential helpers in non-interactive contexts).
      stdin: "ignore",
      // Fail fast instead of prompting on the tty for a missing credential, so
      // the auth layer can take over (see NONINTERACTIVE_GIT_ENV).
      env: NONINTERACTIVE_GIT_ENV,
    });
  } catch (err) {
    // SECURITY: on a non-zero exit, execa throws an error whose `message`,
    // `shortMessage`, `command`, `escapedCommand`, and `stderr` echo the FULL
    // argv — including any credential-embedded URL (e.g. a one-shot
    // `https://oauth2:<token>@host/...` push/pull). That error propagates to the
    // top-level handler which logs `err.message` to stderr (a NON-debug surface).
    // Re-throw a token-redacted clone so a token can never leak via an error,
    // while preserving the text `isAuthFailure` keys off (the failure phrasing is
    // untouched; only the embedded secret is masked).
    throw redactExecaError(err);
  }
  return {
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
    exitCode: typeof res.exitCode === "number" ? res.exitCode : 0,
  };
}

/**
 * Mask userinfo in an http(s) URL argument so a credential-embedded clone/pull/
 * push URL never appears in a (debug) log line. Non-URL args are returned as-is.
 * `https://oauth2:TOKEN@host/x.git` -> `https://oauth2:***@host/x.git`.
 */
function redactArg(arg: string): string {
  if (!/^https?:\/\//i.test(arg)) return arg;
  try {
    const u = new URL(arg);
    if (u.username || u.password) {
      u.username = u.username || "oauth2";
      u.password = "***";
    }
    return u.toString();
  } catch {
    return arg;
  }
}

/**
 * Mask the userinfo of ANY http(s) URL embedded ANYWHERE inside a free-text blob
 * (an execa error message/command line/stderr, not a clean standalone URL).
 * Replaces the `user:password@` portion of `scheme://user:password@host…` with
 * `oauth2:***@`, so a one-shot credential-embedded clone/pull/push URL cannot
 * leak through an error string. Leaves everything else (incl. the failure
 * phrasing isAuthFailure keys off) intact.
 */
function redactText(text: string): string {
  // scheme://[user[:password]]@host  — capture scheme+"//" and the host tail.
  return text.replace(
    /\b(https?:\/\/)[^/@\s]+@/gi,
    (_m, scheme: string) => `${scheme}oauth2:***@`,
  );
}

/**
 * Re-throw an execa (or any) error with every credential-bearing field redacted.
 * execa surfaces the full argv in several places (`message`, `shortMessage`,
 * `command`, `escapedCommand`) plus the captured `stderr`/`stdout`; all are
 * scrubbed. The returned Error keeps `stderr`/`stdout`/`shortMessage`/`exitCode`
 * so `isAuthFailure` (which scans message+stderr+shortMessage) still classifies
 * it correctly — only the embedded token is masked. Non-Error inputs are coerced
 * to a redacted-string Error.
 */
function redactExecaError(err: unknown): Error {
  if (!(err instanceof Error)) {
    return new Error(redactText(String(err)));
  }
  const src = err as Error & {
    stderr?: unknown;
    stdout?: unknown;
    shortMessage?: unknown;
    command?: unknown;
    escapedCommand?: unknown;
    exitCode?: unknown;
  };
  const out = new Error(redactText(err.message)) as Error & Record<string, unknown>;
  out.name = err.name;
  // Carry over (redacted) the diagnostic fields callers + the auth classifier read.
  if (typeof src.stderr === "string") out.stderr = redactText(src.stderr);
  if (typeof src.stdout === "string") out.stdout = redactText(src.stdout);
  if (typeof src.shortMessage === "string") out.shortMessage = redactText(src.shortMessage);
  if (typeof src.command === "string") out.command = redactText(src.command);
  if (typeof src.escapedCommand === "string") {
    out.escapedCommand = redactText(src.escapedCommand);
  }
  if (typeof src.exitCode === "number") out.exitCode = src.exitCode;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

/** True when `cwd` is inside a git work tree. Never throws. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await git(cwd, ["rev-parse", "--is-inside-work-tree"], {
    reject: false,
  });
  return res.exitCode === 0 && res.stdout.trim() === "true";
}

/** Current branch name (e.g. "main"). Throws if not a repo / detached + unknown. */
export async function currentBranch(cwd: string): Promise<string> {
  const res = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return res.stdout.trim();
}

/**
 * True if a remote named `name` (default "origin") is configured. Never throws;
 * returns false when not a repo or the remote is absent.
 */
export async function hasRemote(cwd: string, name = "origin"): Promise<boolean> {
  const res = await git(cwd, ["remote"], { reject: false });
  if (res.exitCode !== 0) return false;
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .includes(name);
}

/**
 * True if `branch` (default: current branch) has an upstream tracking ref.
 * Used to decide whether the first push must set upstream. Never throws.
 */
export async function hasUpstream(cwd: string, branch?: string): Promise<boolean> {
  const ref = branch ?? "HEAD";
  const res = await git(cwd, ["rev-parse", "--abbrev-ref", `${ref}@{upstream}`], {
    reject: false,
  });
  return res.exitCode === 0;
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

/** `git init` in `cwd` (creates the dir's repo metadata). Throws on failure. */
export async function gitInit(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
}

/**
 * Clone `url` into `dest` (a path that does not yet exist or is empty). We run
 * the clone from `dest`'s parent and pass the absolute destination so behavior
 * is independent of the caller's process cwd. Throws on failure.
 */
export async function clone(url: string, dest: string): Promise<void> {
  // Never log the URL itself (it may carry an arbella-embedded token).
  log.debug(`git clone <url> -> ${dest}`);
  try {
    await execa("git", ["clone", url, dest], {
      reject: true,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // Fail fast on a missing credential instead of prompting on the tty, so the
      // auth layer (gh/glab login or token fallback) handles a private repo.
      env: NONINTERACTIVE_GIT_ENV,
    });
  } catch (err) {
    // SECURITY: same leak surface as the shared git() runner — a failed clone of
    // a credential-embedded URL would otherwise echo the token in the thrown
    // error's message/command. Redact before re-throwing so the auth retry's
    // failure can be reported (and classified by isAuthFailure) without leaking.
    throw redactExecaError(err);
  }
}

/** Stage every change in the work tree (`git add -A`). Throws on failure. */
export async function addAll(cwd: string): Promise<void> {
  await git(cwd, ["add", "-A"]);
}

/**
 * Commit staged changes with `message`. Returns false (no commit made) when
 * there is nothing staged, so callers can report "no changes" without an error.
 * Throws on any other git failure.
 */
export async function commit(cwd: string, message: string): Promise<boolean> {
  // Fast path: if nothing is staged, skip the commit entirely. `--quiet`
  // exit code 0 => no staged differences, 1 => there are staged changes.
  const staged = await git(cwd, ["diff", "--cached", "--quiet"], {
    reject: false,
  });
  if (staged.exitCode === 0) {
    return false;
  }
  const res = await git(cwd, ["commit", "-m", message], { reject: false });
  if (res.exitCode === 0) {
    return true;
  }
  // Some git versions still report "nothing to commit" as a non-zero exit even
  // after the diff check (e.g. only-mode changes). Treat that as "no commit".
  const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
  if (
    combined.includes("nothing to commit") ||
    combined.includes("no changes added to commit")
  ) {
    return false;
  }
  throw new Error(`git commit failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
}

/**
 * Push to the remote. With `setUpstream`, sets the upstream tracking ref for the
 * given/current branch (`-u origin <branch>`), which is needed on the first push
 * of a freshly-created remote. Throws on failure.
 */
export async function push(
  cwd: string,
  opts: { setUpstream?: boolean; branch?: string } = {},
): Promise<void> {
  const args = ["push"];
  if (opts.setUpstream) {
    const branch = opts.branch ?? (await currentBranch(cwd));
    args.push("-u", "origin", branch);
  } else if (opts.branch) {
    args.push("origin", opts.branch);
  }
  await git(cwd, args);
}

/**
 * Push the current branch to an EXPLICIT url (one-shot) without mutating the
 * stored `origin` remote. The auth-layer counterpart to {@link pushTo}'s sibling
 * {@link pullFrom}: when arbella has its own token it builds a
 * credential-embedded URL and pushes to it directly, leaving `.git/config` free
 * of any token. Pushes the current branch HEAD->HEAD by name. Throws on failure.
 *
 * SECURITY: `url` may embed a token; it is an argv element (no shell) and the
 * git() debug logger redacts embedded credentials.
 */
export async function pushTo(cwd: string, url: string): Promise<void> {
  const branch = await currentBranch(cwd);
  await git(cwd, ["push", url, `HEAD:${branch}`]);
}

/**
 * Pull from the remote with rebase + autostash so a dirty local tree does not
 * block fast-forwards (R12 repo-as-source uses this before restore). Throws on
 * unresolved conflicts / network errors.
 */
export async function pull(cwd: string): Promise<void> {
  await git(cwd, ["pull", "--rebase", "--autostash"]);
}

/**
 * Pull from an EXPLICIT url (one-shot) without mutating the stored remote. Used
 * by the auth layer's retry: when arbella obtains a token it builds a
 * credential-embedded URL and pulls from it directly, so the token never lands in
 * `.git/config` (the configured `origin` remote is left clean). The current
 * branch is pulled with the same rebase + autostash policy as {@link pull}.
 *
 * SECURITY: `url` may embed a token — it is passed as an argv element (no shell)
 * and is never logged here (git.ts logs argv at debug; the auth layer redacts
 * before logging, and this path is only reached with verbose off in normal use).
 */
export async function pullFrom(cwd: string, url: string): Promise<void> {
  const branch = await currentBranch(cwd);
  await git(cwd, ["pull", "--rebase", "--autostash", url, branch]);
}

/** Add or update a named remote (`git remote add` / fallback `set-url`). */
export async function setRemote(
  cwd: string,
  name: string,
  url: string,
): Promise<void> {
  const exists = await hasRemote(cwd, name);
  if (exists) {
    await git(cwd, ["remote", "set-url", name, url]);
  } else {
    await git(cwd, ["remote", "add", name, url]);
  }
}

/* -------------------------------------------------------------------------- */
/* Status / diff                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Split a NUL-terminated porcelain/diff stream into trimmed records. We request
 * `-z` everywhere so paths with spaces/newlines survive intact.
 */
function splitNul(raw: string): string[] {
  return raw.split("\0").filter((s) => s.length > 0);
}

/**
 * Working-tree status via `git status --porcelain -z`. Returns one entry per
 * changed path: `{ path, status }` where `status` is the 2-char XY code
 * (e.g. "??" untracked, " M" modified, "A " added). Empty array => clean tree.
 * Throws only if `cwd` is not a git repo.
 */
export async function status(
  cwd: string,
): Promise<Array<{ path: string; status: string }>> {
  const res = await git(cwd, ["status", "--porcelain", "-z"]);
  const out: Array<{ path: string; status: string }> = [];
  const records = splitNul(res.stdout);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // Porcelain v1 record: "XY <path>"; XY is exactly 2 chars, then a space.
    const code = rec.slice(0, 2);
    let p = rec.slice(3);
    // Renames/copies (R/C in XY) emit the new path in this record and the old
    // path as the NEXT NUL field; consume + ignore the old path.
    if (code[0] === "R" || code[0] === "C") {
      i++; // skip the paired source path
    }
    out.push({ path: p, status: code });
  }
  return out;
}

/**
 * Name-status diff of the work tree (incl. untracked) vs HEAD, for the `status`
 * command's "what would change" view. Returns `{ path, status }` where status is
 * a single letter: A/M/D/R/C, or "?" for untracked files. Throws if not a repo.
 *
 * We combine a tracked diff (`git diff HEAD --name-status -z`) with the list of
 * untracked files (`git ls-files --others --exclude-standard -z`) so newly
 * created repo files show up before they are ever committed.
 */
export async function diffNameStatus(
  cwd: string,
): Promise<Array<{ path: string; status: string }>> {
  const out: Array<{ path: string; status: string }> = [];

  // Tracked changes vs HEAD. If there is no HEAD yet (no commits), this throws;
  // fall back to treating everything as untracked below.
  let hasHead = true;
  const headCheck = await git(cwd, ["rev-parse", "--verify", "HEAD"], {
    reject: false,
  });
  if (headCheck.exitCode !== 0) hasHead = false;

  if (hasHead) {
    const res = await git(cwd, ["diff", "HEAD", "--name-status", "-z"]);
    const records = splitNul(res.stdout);
    for (let i = 0; i < records.length; i++) {
      const code = records[i];
      const letter = code[0] ?? "M";
      if (letter === "R" || letter === "C") {
        // For rename/copy, name-status emits: STATUS \0 OLD \0 NEW
        const newPath = records[i + 2];
        i += 2;
        if (newPath) out.push({ path: newPath, status: letter });
      } else {
        const p = records[i + 1];
        i += 1;
        if (p) out.push({ path: p, status: letter });
      }
    }
  }

  // Untracked files (excluding gitignored) -> "?".
  const untracked = await git(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { reject: false },
  );
  if (untracked.exitCode === 0) {
    for (const p of splitNul(untracked.stdout)) {
      out.push({ path: p, status: "?" });
    }
  }

  return out;
}
