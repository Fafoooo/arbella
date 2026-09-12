import { analyzeCommits as analyzeConventionalCommits } from "@semantic-release/commit-analyzer";

/** Graduate the existing 0.x releases to 1.0.0, then release every main update. */
export async function analyzeCommits(pluginConfig, context) {
  if (context.commits.length === 0) return null;
  if (!context.lastRelease.version || context.lastRelease.version.startsWith("0.")) {
    return "major";
  }

  return (await analyzeConventionalCommits(pluginConfig, context)) || "patch";
}
