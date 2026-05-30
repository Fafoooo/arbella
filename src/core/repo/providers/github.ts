/**
 * GitHub repo provider (R11). Creates a PRIVATE backup repo via the `gh` CLI.
 *
 * We never create a public repo — the backup repo holds sanitized but still
 * personal config, so `createRepo` always passes `--private` unless the caller
 * explicitly opts out (which `init` never does).
 *
 * All shelling out goes through `execa("gh", [...])` with array args (no shell
 * interpolation). When `gh` is missing or unauthenticated we surface that as a
 * thrown error from the create/exists paths, but `isAvailable()` stays a clean
 * boolean so callers can fall back to the generic provider.
 */

import { execa } from "execa";

import type { RepoProvider } from "../../../types.js";
import { log } from "../../../utils/log.js";
import type { RepoProviderApi } from "../index.js";

/** True if the `gh` binary runs at all (so we can probe further). */
async function ghPresent(): Promise<boolean> {
  try {
    await execa("gh", ["--version"], { reject: true, stdin: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Run `gh` capturing stdout; throws (with a friendly message) on failure. */
async function gh(args: string[]): Promise<string> {
  log.debug(`gh ${args.join(" ")}`);
  try {
    const res = await execa("gh", args, {
      reject: true,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    return typeof res.stdout === "string" ? res.stdout : "";
  } catch (err) {
    const e = err as { stderr?: string; shortMessage?: string };
    const detail = (e.stderr && e.stderr.trim()) || e.shortMessage || String(err);
    throw new Error(`gh ${args[0] ?? ""} failed: ${detail}`);
  }
}

/**
 * Pick the preferred clone URL from a `gh repo view --json sshUrl,url` payload.
 * Prefer SSH (matches typical push auth for a private repo); fall back to the
 * https web URL turned into a .git clone URL.
 */
function pickCloneUrl(json: { sshUrl?: string; url?: string }): string {
  if (json.sshUrl && json.sshUrl.length > 0) return json.sshUrl;
  if (json.url && json.url.length > 0) {
    return json.url.endsWith(".git") ? json.url : `${json.url}.git`;
  }
  throw new Error("gh repo view returned no usable clone URL");
}

/**
 * Normalize provider input into the `OWNER/NAME` form `gh` expects, accepting:
 *   - "owner/name"
 *   - "name"                      (gh resolves to the authed user)
 *   - "https://github.com/o/n"    -> "o/n"
 *   - "git@github.com:o/n.git"    -> "o/n"
 * Returns the slug; an unrecognized full URL for a different host is returned
 * unchanged so `resolveUrl` can still hand it back verbatim.
 */
function toSlug(input: string): string {
  const trimmed = input.trim();
  // git@host:owner/name(.git)
  const ssh = trimmed.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (ssh) return ssh[1];
  // https://host/owner/name(.git)
  const https = trimmed.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/);
  if (https) return https[1];
  return trimmed.replace(/\.git$/, "");
}

export const githubProvider: RepoProviderApi = {
  id: "github" as RepoProvider,

  async isAvailable(): Promise<boolean> {
    return ghPresent();
  },

  async repoExists(name: string): Promise<boolean> {
    const slug = toSlug(name);
    try {
      // `gh repo view` exits non-zero (-> throws here) when the repo is absent
      // or inaccessible; we treat any failure as "does not exist for us".
      await gh(["repo", "view", slug, "--json", "name"]);
      return true;
    } catch {
      return false;
    }
  },

  async createRepo(
    name: string,
    opts: { private?: boolean; description?: string } = {},
  ): Promise<string> {
    const slug = toSlug(name);
    const isPrivate = opts.private ?? true; // R11: default PRIVATE, never public.
    const args = ["repo", "create", slug, isPrivate ? "--private" : "--public"];
    if (opts.description) {
      args.push("--description", opts.description);
    }
    // Do not clone here; the repo orchestrator (index.ts) owns the local clone.
    args.push("--clone=false");
    await gh(args);
    log.success(`Created private GitHub repo ${slug}`);
    return this.resolveUrl(slug);
  },

  async resolveUrl(input: string): Promise<string> {
    const trimmed = input.trim();
    // A full clone URL for github was given -> hand it back unchanged.
    if (/^git@/.test(trimmed) || /^https?:\/\//.test(trimmed)) {
      // If it's a github URL we could still normalize, but returning verbatim
      // honors exactly what the user supplied for `generic`-style inputs.
      if (/github\.com/.test(trimmed)) return trimmed;
    }
    const slug = toSlug(trimmed);
    const raw = await gh(["repo", "view", slug, "--json", "sshUrl,url"]);
    let parsed: { sshUrl?: string; url?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Could not parse gh repo view output for ${slug}`);
    }
    return pickCloneUrl(parsed);
  },
};

export default githubProvider;
