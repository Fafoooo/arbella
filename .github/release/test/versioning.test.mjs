import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import semanticRelease from "semantic-release";
import { analyzeCommits } from "../analyze-commits.mjs";
import config from "../release.config.cjs";

const configPath = fileURLToPath(new URL("../release.config.cjs", import.meta.url));
const logger = { log() {} };

for (const [version, messages, expected] of [
  ["0.2.0", ["fix: restore linked skills"], "major"],
  [undefined, ["initial commit"], "major"],
  ["1.0.0", ["fix: restore linked skills"], "patch"],
  ["1.0.0", ["docs: explain setup"], "patch"],
  ["1.0.0", ["chore: refresh dependencies"], "patch"],
  ["1.0.0", ["Update README"], "patch"],
  ["1.0.0", ["fix: restore", "feat: add adapter"], "minor"],
  ["1.0.0", ["feat!: replace the manifest format"], "major"],
  ["1.0.0", ["fix(config)!: require a new setting"], "major"],
  ["1.0.0", ["feat: new format\n\nBREAKING CHANGE: old manifests are unsupported"], "major"],
  ["0.2.0", [], null],
  ["1.0.0", [], null],
]) {
  test(`${version ?? "unreleased"}: ${messages.join("; ") || "no new commits"} -> ${expected}`, async () => {
    const actual = await analyzeCommits(config.plugins[0][1], {
      cwd: path.dirname(configPath),
      lastRelease: { version },
      commits: messages.map((message, index) => ({ message, hash: String(index) })),
      logger,
    });
    assert.equal(actual, expected);
  });
}

test("release flow graduates to 1.0.0, skips repeats, and increments subsequent versions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "arbella-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  const home = path.join(root, "home");
  const remote = path.join(root, "remote.git");
  await mkdir(cwd);
  await mkdir(home);

  // No host credentials, global Git configuration, or network remotes in this test.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Release test",
    GIT_AUTHOR_EMAIL: "release@example.invalid",
    GIT_COMMITTER_NAME: "Release test",
    GIT_COMMITTER_EMAIL: "release@example.invalid",
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    NPM_CONFIG_OFFLINE: "true",
  };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", "--initial-branch=main", remote);
  git("init", "--initial-branch=main");
  git("remote", "add", "origin", pathToFileURL(remote).href);
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({
    name: "arbella-release-fixture",
    version: "0.2.0",
    description: "Local release test fixture",
    license: "MIT",
  }));
  git("add", "package.json");
  git("commit", "-m", "feat: initial CLI");
  git("tag", "v0.2.0");
  git("push", "-u", "origin", "main", "--tags");

  const commit = (message) => {
    git("commit", "--allow-empty", "-m", message);
    git("push", "origin", "main");
  };
  const release = async () => {
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    return semanticRelease({
      extends: configPath,
      repositoryUrl: pathToFileURL(remote).href,
      ci: false,
      // Exercise real tagging, version preparation, and packing, but never publish externally.
      plugins: [config.plugins[0], config.plugins[1], [config.plugins[2], {
        npmPublish: false,
        tarballDir: "artifacts",
      }]],
    }, { cwd, env: { ...env }, stdout: sink, stderr: sink });
  };

  commit("fix: restore linked skills");
  let result = await release();
  assert.equal(result.nextRelease.version, "1.0.0");
  assert.equal(result.nextRelease.gitTag, "v1.0.0");
  assert.ok(git("ls-remote", "--tags", "origin").includes("refs/tags/v1.0.0"));
  assert.equal(JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")).version, "1.0.0");
  const packedManifest = execFileSync("tar", ["-xOf", path.join(cwd, "artifacts", "arbella-release-fixture-1.0.0.tgz"), "package/package.json"], { encoding: "utf8" });
  assert.equal(JSON.parse(packedManifest).version, "1.0.0");
  assert.equal(await release(), false, "a successful release must not publish twice");

  commit("Update README");
  result = await release();
  assert.equal(result.nextRelease.version, "1.0.1");

  commit("feat: add an adapter");
  result = await release();
  assert.equal(result.nextRelease.version, "1.1.0");

  commit("feat!: replace the manifest format");
  result = await release();
  assert.equal(result.nextRelease.version, "2.0.0");
  assert.equal(await release(), false);
});
