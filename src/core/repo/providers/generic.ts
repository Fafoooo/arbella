/**
 * Generic repo provider (R11). For any git remote that arbella cannot (or
 * should not) auto-create: the user supplies a ready-made remote URL.
 *
 * There is no hosting API here, so:
 *   - isAvailable() is always true (plain git is the only requirement),
 *   - repoExists() assumes true (we cannot probe without a host API; the caller
 *     will simply try to clone/push and surface any git error),
 *   - createRepo() never creates anything — it just hands the input back as the
 *     clone URL (and warns, since "creation" is a no-op for generic),
 *   - resolveUrl() returns the input verbatim.
 */

import type { RepoProvider } from "../../../types.js";
import { log } from "../../../utils/log.js";
import type { RepoProviderApi } from "../index.js";

export const genericProvider: RepoProviderApi = {
  id: "generic" as RepoProvider,

  async isAvailable(): Promise<boolean> {
    // Plain git is assumed present; nothing host-specific to detect.
    return true;
  },

  async repoExists(_name: string): Promise<boolean> {
    // No host API to query — assume the user-supplied remote already exists.
    return true;
  },

  async createRepo(
    name: string,
    _opts: { private?: boolean; description?: string } = {},
  ): Promise<string> {
    // Nothing to create for a generic remote: the user must have provisioned it.
    log.warn(
      "Generic provider does not create remotes; using the supplied URL as-is. " +
        "Create the (private) repository on your host first if it does not exist.",
    );
    return this.resolveUrl(name);
  },

  async resolveUrl(input: string): Promise<string> {
    // The input IS the clone URL for a generic remote.
    return input.trim();
  },
};

export default genericProvider;
