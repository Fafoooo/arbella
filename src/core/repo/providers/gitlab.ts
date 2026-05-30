/**
 * GitLab repo provider (R11). Creates a PRIVATE backup repo via the `glab` CLI.
 *
 * Mirrors the GitHub provider: array-only `execa` calls, always `--private`
 * (never public), `isAvailable()` is a clean boolean so the orchestrator can
 * fall back to the generic provider when `glab` is missing/unauthenticated.
 *
 * `glab repo view <path> -F json` returns a project object whose clone URLs are
 * `ssh_url_to_repo` / `http_url_to_repo` (with `web_url` as a last resort).
 */

import { execa } from "execa";

import type { RepoProvider } from "../../../types.js";
import { log } from "../../../utils/log.js";
import type { RepoProviderApi } from "../index.js";

/** True if the `glab` binary runs at all. */
async function glabPresent(): Promise<boolean> {
  try {
    await execa("glab", ["--version"], { reject: true, stdin: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Run `glab` capturing stdout; throws (with a friendly message) on failure. */
async function glab(args: string[]): Promise<string> {
  log.debug(`glab ${args.join(" ")}`);
  try {
    const res = await execa("glab", args, {
      reject: true,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    return typeof res.stdout === "string" ? res.stdout : "";
  } catch (err) {
    const e = err as { stderr?: string; shortMessage?: string };
    const detail = (e.stderr && e.stderr.trim()) || e.shortMessage || String(err);
    throw new Error(`glab ${args[0] ?? ""} failed: ${detail}`);
  }
}

/** Project JSON shape (subset) returned by `glab repo view -F json`. */
interface GlabProject {
  ssh_url_to_repo?: string;
  http_url_to_repo?: string;
  web_url?: string;
}

/** Prefer SSH, then http(s) clone URL, then derive one from web_url. */
function pickCloneUrl(p: GlabProject): string {
  if (p.ssh_url_to_repo && p.ssh_url_to_repo.length > 0) return p.ssh_url_to_repo;
  if (p.http_url_to_repo && p.http_url_to_repo.length > 0) return p.http_url_to_repo;
  if (p.web_url && p.web_url.length > 0) {
    return p.web_url.endsWith(".git") ? p.web_url : `${p.web_url}.git`;
  }
  throw new Error("glab repo view returned no usable clone URL");
}

/**
 * Normalize provider input into the `namespace/name` path `glab` expects.
 * Accepts "group/name", "name", a full https URL, or an ssh URL. Unrecognized
 * inputs are returned with any trailing ".git" stripped.
 */
function toPath(input: string): string {
  const trimmed = input.trim();
  const ssh = trimmed.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (ssh) return ssh[1];
  const https = trimmed.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/);
  if (https) return https[1];
  return trimmed.replace(/\.git$/, "");
}

export const gitlabProvider: RepoProviderApi = {
  id: "gitlab" as RepoProvider,

  async isAvailable(): Promise<boolean> {
    return glabPresent();
  },

  async repoExists(name: string): Promise<boolean> {
    const p = toPath(name);
    try {
      await glab(["repo", "view", p, "-F", "json"]);
      return true;
    } catch {
      return false;
    }
  },

  async createRepo(
    name: string,
    opts: { private?: boolean; description?: string } = {},
  ): Promise<string> {
    const p = toPath(name);
    const isPrivate = opts.private ?? true; // R11: default PRIVATE, never public.
    const args = ["repo", "create", p, isPrivate ? "--private" : "--public"];
    if (opts.description) {
      args.push("--description", opts.description);
    }
    await glab(args);
    log.success(`Created private GitLab repo ${p}`);
    return this.resolveUrl(p);
  },

  async resolveUrl(input: string): Promise<string> {
    const trimmed = input.trim();
    if (/^git@/.test(trimmed) || /^https?:\/\//.test(trimmed)) {
      if (/gitlab/.test(trimmed)) return trimmed;
    }
    const p = toPath(trimmed);
    const raw = await glab(["repo", "view", p, "-F", "json"]);
    let parsed: GlabProject;
    try {
      parsed = JSON.parse(raw) as GlabProject;
    } catch {
      throw new Error(`Could not parse glab repo view output for ${p}`);
    }
    return pickCloneUrl(parsed);
  },
};

export default gitlabProvider;
