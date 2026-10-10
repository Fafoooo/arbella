import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyPlacement,
  decide,
  formatPullSummary,
  newPullSession,
  noteMissingSecrets,
  placeFile,
  planPlacement,
  recordExternalWrite,
  type PlaceCtx,
  type PullSession,
} from "../../src/core/placement/index.js";
import { loadLedger, saveLedger, sha256, stillMissing, type Ledger } from "../../src/core/placement/ledger.js";
import { HOOK_TAG } from "../../src/core/autobackup/hook.js";
import { REDACTED as R } from "../../src/core/sanitizer/patterns.js";
import { parse as parseToml } from "smol-toml";
import { fs } from "../../src/utils/fs.js";
import type { Logger } from "../../src/types.js";

let dir: string;
let warns: string[];
const log: Logger = {
  info() {}, success() {}, error() {}, step() {}, debug() {},
  warn: (m: string) => { warns.push(m); },
};
const emptyLedger = (): Ledger => ({ version: 1, files: {}, missingSecrets: [] });
const buf = (s: string) => Buffer.from(s);

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "placement-"));
  warns = [];
});
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

const ctxOf = (pull?: PullSession, extra: Partial<PlaceCtx> = {}): PlaceCtx =>
  ({ fs, log, sourceOfTruth: "local", pull, ...extra }) as PlaceCtx;
const session = (role: "source" | "follower", force = false, ledger = emptyLedger()) =>
  newPullSession({ role, force, ledger });
const base = {
  local: buf("old"),
  next: buf("new"),
  localBroken: false,
  keepsSecrets: false,
  ledgerMatch: false,
  secretSafe: true,
};

describe("decide", () => {
  it("row 1: missing target is written", () => {
    expect(decide({ ...base, role: "source", force: false, local: undefined })).toBe("written");
  });
  it("row 2: identical content is identical", () => {
    expect(decide({ ...base, role: "source", force: true, local: buf("new") })).toBe("identical");
  });
  it("row 2: keepsSecrets beats force", () => {
    expect(decide({ ...base, role: "source", force: true, keepsSecrets: true })).toBe("identical");
  });
  it("row 3: local marker is written even without force", () => {
    expect(decide({ ...base, role: "source", force: false, localBroken: true })).toBe("written");
  });
  it("row 4: force writes", () => {
    expect(decide({ ...base, role: "source", force: true })).toBe("written");
  });
  it("row 5: follower with unchanged ledger hash is written", () => {
    expect(decide({ ...base, role: "follower", force: false, ledgerMatch: true })).toBe("written");
  });
  it("row 6: follower without ledger entry keeps a differing file", () => {
    expect(decide({ ...base, role: "follower", force: false })).toBe("kept");
  });
  it("row 6: follower with a changed file keeps it; source ignores the ledger", () => {
    expect(decide({ ...base, role: "follower", force: false, ledgerMatch: false })).toBe("kept");
    expect(decide({ ...base, role: "source", force: false, ledgerMatch: true })).toBe("kept");
  });
  it("neither force nor a follower ledger match overrides a file that is not secret-safe", () => {
    expect(decide({ ...base, role: "source", force: true, secretSafe: false })).toBe("kept");
    expect(decide({ ...base, role: "follower", force: false, ledgerMatch: true, secretSafe: false })).toBe("kept");
    expect(decide({ ...base, role: "source", force: true, secretSafe: false, localBroken: true })).toBe("written");
    expect(decide({ ...base, role: "source", force: true, secretSafe: false, keepsSecrets: true })).toBe("identical");
  });
});

describe("placeFile", () => {
  it("structured repo file: output omits the key and records missing", async () => {
    const dest = path.join(dir, "settings.json");
    const s = session("source", true);
    const content = `{"env":{"K":"${R}"},"a":1}`;
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content })).toBe("written");
    expect(JSON.parse(await fsp.readFile(dest, "utf8"))).toEqual({ env: {}, a: 1 });
    expect(s.report.missingSecrets).toEqual([{ tool: "claude", file: dest, keyPath: ["env", "K"] }]);
    expect(s.report.redactedText).toEqual([]);
  });

  it("keeps a real local secret on a forced pull by merging it into a parseable file", async () => {
    const dest = path.join(dir, "c.json");
    await fsp.writeFile(dest, '{"env":{"K":"real"},"a":2}');
    const ledger = { ...emptyLedger(), files: { [dest]: "h" } };
    const s = session("source", true, ledger);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: `{"env":{"K":"${R}"},"a":1}` })).toBe(
      "written",
    );
    expect(JSON.parse(await fsp.readFile(dest, "utf8"))).toEqual({ env: { K: "real" }, a: 1 });
    expect(s.report.missingSecrets).toEqual([]);
    expect(s.report.keptForSecrets).toEqual([]);
  });

  it("keeps a codex config.toml whose mcp command changed, even forced, and lists it", async () => {
    const dest = path.join(dir, "config.toml");
    const local = '[mcp_servers.u]\ncommand = "good"\n\n[mcp_servers.u.env]\nTOKEN = "real"\n';
    await fsp.writeFile(dest, local);
    const s = session("source", true);
    const repo = `[mcp_servers.u]\ncommand = "evil"\n\n[mcp_servers.u.env]\nTOKEN = "${R}"\n`;
    expect(await placeFile(ctxOf(s), { bucket: "codex", dest, content: repo })).toBe("kept");
    expect(await fsp.readFile(dest, "utf8")).toBe(local);
    expect(s.report.keptForSecrets).toEqual([dest]);
  });

  it("keeps an unsafe file for a follower with a matching ledger hash too", async () => {
    const dest = path.join(dir, "m.json");
    const local = '{"mcpServers":{"s":{"command":"good","env":{"T":"real"}}}}';
    await fsp.writeFile(dest, local);
    const s = session("follower", false, { ...emptyLedger(), files: { [dest]: sha256(local) } });
    const repo = `{"mcpServers":{"s":{"command":"evil","env":{"T":"${R}"}}}}`;
    expect(await placeFile(ctxOf(s), { bucket: "cursor", dest, content: repo })).toBe("kept");
    expect(await fsp.readFile(dest, "utf8")).toBe(local);
    expect(s.report.keptForSecrets).toEqual([dest]);
  });

  it("identical-via-secrets does not touch the ledger or the file", async () => {
    const dest = path.join(dir, "run.sh");
    await fsp.writeFile(dest, "TOKEN=abc123\necho hi\n");
    const s = session("follower", true, { ...emptyLedger(), files: { [dest]: "keep" } });
    const out = await placeFile(ctxOf(s), { bucket: "claude", dest, content: `TOKEN=${R}\necho hi\n` });
    expect(out).toBe("identical");
    expect(s.ledger.files[dest]).toBe("keep");
    expect(await fsp.readFile(dest, "utf8")).toBe("TOKEN=abc123\necho hi\n");
    expect(s.report.redactedText).toEqual([]);
    expect(s.report.tools.claude).toEqual({ written: 0, identical: 1, kept: [] });
  });

  it("plain identical records sha(local); written records sha(next)", async () => {
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    await fsp.writeFile(a, "same");
    const s = session("follower");
    await placeFile(ctxOf(s), { bucket: "t", dest: a, content: "same" });
    await placeFile(ctxOf(s), { bucket: "t", dest: b, content: "fresh" });
    expect(s.ledger.files[a]).toBe(sha256("same"));
    expect(s.ledger.files[b]).toBe(sha256("fresh"));
  });

  it("kept does not touch the ledger and is listed", async () => {
    const dest = path.join(dir, "k.txt");
    await fsp.writeFile(dest, "mine");
    const s = session("follower", false, { ...emptyLedger(), files: { [dest]: "old-hash" } });
    expect(await placeFile(ctxOf(s), { bucket: "t", dest, content: "theirs" })).toBe("kept");
    expect(await fsp.readFile(dest, "utf8")).toBe("mine");
    expect(s.ledger.files[dest]).toBe("old-hash");
    expect(s.report.tools.t!.kept).toEqual([dest]);
  });

  it("follower overwrites a ledger-unchanged file", async () => {
    const dest = path.join(dir, "u.txt");
    await fsp.writeFile(dest, "v1");
    const s = session("follower", false, { ...emptyLedger(), files: { [dest]: sha256("v1") } });
    expect(await placeFile(ctxOf(s), { bucket: "t", dest, content: "v2" })).toBe("written");
    expect(await fsp.readFile(dest, "utf8")).toBe("v2");
  });

  it("text file with markers that cannot be merged is written and listed", async () => {
    const dest = path.join(dir, "n.md");
    const s = session("source", true);
    await placeFile(ctxOf(s), { bucket: "t", dest, content: `key: ${R}\n` });
    expect(await fsp.readFile(dest, "utf8")).toBe(`key: ${R}\n`);
    expect(s.report.redactedText).toEqual([dest]);
  });

  it("unparseable structured repo file falls back to the text rule", async () => {
    const dest = path.join(dir, "bad.json");
    const s = session("source", true);
    await placeFile(ctxOf(s), { bucket: "t", dest, content: `{ ${R}` });
    expect(s.report.redactedText).toEqual([dest]);
  });

  it("local marker file is repaired even when not forced", async () => {
    const dest = path.join(dir, "broken.json");
    await fsp.writeFile(dest, `{"k":"${R}"}`);
    const s = session("source", false);
    expect(await placeFile(ctxOf(s), { bucket: "t", dest, content: '{"k":"v"}' })).toBe("written");
  });

  it("writes binary content and honours mode", async () => {
    const dest = path.join(dir, "bin", "x.bin");
    const bytes = Buffer.from([0, 1, 2, 255]);
    const s = session("source", true);
    await placeFile(ctxOf(s), { bucket: "t", dest, content: bytes, mode: 0o600 });
    expect(await fsp.readFile(dest)).toEqual(bytes);
    await placeFile(ctxOf(s), { bucket: "t", dest, content: Buffer.from([9]), direct: true });
    expect(await fsp.readFile(dest)).toEqual(Buffer.from([9]));
  });

  it("direct writer is used only when direct", async () => {
    const calls: string[] = [];
    const spy = {
      ...fs,
      write: async (...a: Parameters<typeof fs.write>) => { calls.push("write"); return fs.write(...a); },
      writeAtomic: async (...a: Parameters<typeof fs.writeAtomic>) => { calls.push("atomic"); return fs.writeAtomic(...a); },
    };
    const c = { ...ctxOf(session("source", true)), fs: spy } as PlaceCtx;
    await placeFile(c, { bucket: "t", dest: path.join(dir, "d1"), content: "x" });
    await placeFile(c, { bucket: "t", dest: path.join(dir, "d2"), content: "x", direct: true });
    expect(calls).toEqual(["atomic", "write"]);
  });

  it("dryRun writes and records nothing", async () => {
    const dest = path.join(dir, "dry.txt");
    const s = session("source", true);
    const c = ctxOf(s, { dryRun: true });
    const d = await planPlacement(c, { bucket: "t", dest, content: "x" });
    expect(d.outcome).toBe("written");
    expect(await applyPlacement(c, { bucket: "t", dest, content: "x" }, d)).toBe("written");
    recordExternalWrite(c, dest, "x");
    noteMissingSecrets(c, [{ tool: "t", file: dest, keyPath: ["a"] }]);
    expect(await fs.exists(dest)).toBe(false);
    expect(s.ledger.files).toEqual({});
    expect(s.report).toEqual({ tools: {}, redactedText: [], missingSecrets: [], keptForSecrets: [] });
  });

  it("no session: legacy policy, redacted merge still applied, nothing recorded", async () => {
    const dest = path.join(dir, "legacy.json");
    await fsp.writeFile(dest, '{"env":{"K":"real"}}');
    const repo = { bucket: "t", dest, content: `{"env":{"K":"${R}"},"a":1}` };
    expect(await placeFile(ctxOf(undefined, { sourceOfTruth: "local" }), repo)).toBe("kept");
    expect(await placeFile(ctxOf(undefined, { sourceOfTruth: "repo" }), repo)).toBe("written");
    expect(JSON.parse(await fsp.readFile(dest, "utf8"))).toEqual({ env: { K: "real" }, a: 1 });
    noteMissingSecrets(ctxOf(), []);
    recordExternalWrite(ctxOf(), dest, "x");
  });

  it("unreadable local is kept unless force", async () => {
    const dest = path.join(dir, "adir");
    await fsp.mkdir(dest);
    const repo = { bucket: "t", dest, content: "x" };
    expect((await planPlacement(ctxOf(session("source")), repo)).outcome).toBe("kept");
    const forced = await planPlacement(ctxOf(session("source", true)), repo);
    expect(forced.outcome).toBe("written");
    // Still an overwrite: callers gate their safety copy on this.
    expect(forced.overwrites).toBe(true);
  });

  it("recordExternalWrite and noteMissingSecrets update the session", () => {
    const s = session("source");
    recordExternalWrite(ctxOf(s), "/x", buf("abc"));
    noteMissingSecrets(ctxOf(s), [{ tool: "t", file: "/x", keyPath: ["a"] }]);
    expect(s.ledger.files["/x"]).toBe(sha256("abc"));
    expect(s.report.missingSecrets).toHaveLength(1);
  });
});

describe("secret-blind ledger and narrow marker repair", () => {
  const toml = (name: string, p?: string) =>
    `name = "${name}"\n\n[mcp_servers.u.env]\n${p ? `P = "${p}"\n` : ""}Q = "1"\n`;
  const repoToml = (name: string) => `name = "${name}"\n\n[mcp_servers.u.env]\nP = "${R}"\nQ = "1"\n`;

  it("a filled-in secret does not make a follower config 'changed locally'", async () => {
    const dest = path.join(dir, "config.toml");
    const s1 = session("follower");
    expect(await placeFile(ctxOf(s1), { bucket: "codex", dest, content: repoToml("a") })).toBe("written");
    expect(s1.report.missingSecrets).toHaveLength(1);
    await fsp.writeFile(dest, toml("a", "real-value"));
    const s2 = session("follower", false, s1.ledger);
    expect(await placeFile(ctxOf(s2), { bucket: "codex", dest, content: repoToml("b") })).toBe("written");
    const out = await fsp.readFile(dest, "utf8");
    expect(out).toContain('P = "real-value"');
    expect(out).toContain('name = "b"');
    expect(s2.report.missingSecrets).toEqual([]);
  });

  it("a real local edit of another key is still kept", async () => {
    const dest = path.join(dir, "config.toml");
    const s1 = session("follower");
    await placeFile(ctxOf(s1), { bucket: "codex", dest, content: repoToml("a") });
    await fsp.writeFile(dest, toml("mine", "real-value"));
    const s2 = session("follower", false, s1.ledger);
    expect(await placeFile(ctxOf(s2), { bucket: "codex", dest, content: repoToml("b") })).toBe("kept");
  });

  it("works for JSON settings too, and plain identical records the blind hash", async () => {
    const dest = path.join(dir, "settings.json");
    const repo = (a: number) => `{"a":${a},"env":{"K":"${R}"}}`;
    const s1 = session("follower");
    await placeFile(ctxOf(s1), { bucket: "claude", dest, content: repo(1) });
    await fsp.writeFile(dest, '{"a":1,"env":{"K":"real"}}');
    const s2 = session("follower", false, s1.ledger);
    expect(await placeFile(ctxOf(s2), { bucket: "claude", dest, content: repo(1) })).toBe("identical");
    expect(await placeFile(ctxOf(s2), { bucket: "claude", dest, content: repo(2) })).toBe("written");
    expect(JSON.parse(await fsp.readFile(dest, "utf8"))).toEqual({ a: 2, env: { K: "real" } });
  });

  it("a memory note that mentions the marker and was edited locally is kept", async () => {
    const dest = path.join(dir, "note.md");
    await fsp.writeFile(dest, `The marker ${R} is used by arbella. Edited today.`);
    const s = session("source", false);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: "older note" })).toBe("kept");
    expect(s.report.redactedText).toEqual([dest]);
  });

  it("a local script equal to the repo except a marker value is repaired", async () => {
    const dest = path.join(dir, "run.sh");
    await fsp.writeFile(dest, `TOKEN=${R}\necho hi\n`);
    const s = session("source", false);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: "TOKEN=abc\necho hi\n" })).toBe("written");
    expect(await fsp.readFile(dest, "utf8")).toBe("TOKEN=abc\necho hi\n");
    expect(s.report.redactedText).toEqual([]);
  });

  it("a local settings.json with a marker is repaired from the local document", async () => {
    const dest = path.join(dir, "settings.json");
    await fsp.writeFile(dest, `{"env":{"K":"real","L":"${R}"},"x":1}`);
    const s = session("source", false);
    const content = `{"env":{"K":"${R}","L":"${R}"},"x":2}`;
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content })).toBe("written");
    expect(JSON.parse(await fsp.readFile(dest, "utf8"))).toEqual({ env: { K: "real" }, x: 1 });
    expect(s.report.missingSecrets).toEqual([{ tool: "claude", file: dest, keyPath: ["env", "L"] }]);
  });

  it("binary content is never repaired", async () => {
    const dest = path.join(dir, "b.bin");
    await fsp.writeFile(dest, Buffer.from(`x${R}`));
    const s = session("source", false);
    expect(await placeFile(ctxOf(s), { bucket: "t", dest, content: Buffer.from("y") })).toBe("kept");
  });

  it("a missing secret stays reported on later pulls, whether the file is identical or kept", async () => {
    const dest = path.join(dir, "config.toml");
    const missing = [{ tool: "codex", file: dest, keyPath: ["mcp_servers", "u", "env", "P"] }];
    const s1 = session("follower");
    expect(await placeFile(ctxOf(s1), { bucket: "codex", dest, content: repoToml("a") })).toBe("written");
    expect(s1.report.missingSecrets).toEqual(missing);

    const s2 = session("follower", false, s1.ledger);
    expect(await placeFile(ctxOf(s2), { bucket: "codex", dest, content: repoToml("a") })).toBe("identical");
    expect(s2.report.missingSecrets).toEqual(missing);

    await fsp.writeFile(dest, toml("mine"));
    const s3 = session("follower", false, s2.ledger);
    expect(await placeFile(ctxOf(s3), { bucket: "codex", dest, content: repoToml("b") })).toBe("kept");
    expect(s3.report.missingSecrets).toEqual(missing);
  });

  it("identical-via-secrets on a structured file records its secret-blind hash", async () => {
    const dest = path.join(dir, "config.toml");
    await fsp.writeFile(dest, toml("a", "real-value"));
    const s1 = session("follower");
    expect(await placeFile(ctxOf(s1), { bucket: "codex", dest, content: repoToml("a") })).toBe("identical");
    expect(s1.report.missingSecrets).toEqual([]);
    expect(s1.ledger.files[dest]).toEqual(expect.any(String));

    const s2 = session("follower", false, s1.ledger);
    expect(await placeFile(ctxOf(s2), { bucket: "codex", dest, content: repoToml("b") })).toBe("written");
    const out = await fsp.readFile(dest, "utf8");
    expect(out).toContain('P = "real-value"');
    expect(out).toContain('name = "b"');
  });
});

describe("a real local secret is never overwritten", () => {
  const repoScript = `#!/bin/sh\nTOKEN=${R}\necho hi\n`;
  const localScript = "#!/bin/sh\nTOKEN=xyz.FakeToken0123456789abcdefgh\necho edited\n";

  it("force keeps a text file holding a real value where the repo has the marker", async () => {
    const dest = path.join(dir, "run.sh");
    await fsp.writeFile(dest, localScript);
    const s = session("source", true);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: repoScript })).toBe("kept");
    expect(await fsp.readFile(dest, "utf8")).toBe(localScript);
    expect(s.report.tools.claude!.kept).toEqual([dest]);
    expect(s.report.keptForSecrets).toEqual([dest]);
  });

  it("a follower ledger match keeps it too", async () => {
    const dest = path.join(dir, "run.sh");
    await fsp.writeFile(dest, localScript);
    const s = session("follower", false, { ...emptyLedger(), files: { [dest]: sha256(localScript) } });
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: repoScript })).toBe("kept");
    expect(await fsp.readFile(dest, "utf8")).toBe(localScript);
    expect(s.report.keptForSecrets).toEqual([dest]);
  });

  it("a local script that still holds the marker itself is written", async () => {
    const dest = path.join(dir, "run.sh");
    await fsp.writeFile(dest, `#!/bin/sh\nTOKEN=${R}\necho edited\n`);
    const s = session("source", true);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: repoScript })).toBe("written");
    expect(await fsp.readFile(dest, "utf8")).toBe(repoScript);
    expect(s.report.keptForSecrets).toEqual([]);
  });

  it("a plain kept file without force is not listed as kept for secrets", async () => {
    const dest = path.join(dir, "run.sh");
    await fsp.writeFile(dest, localScript);
    const s = session("source", false);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: repoScript })).toBe("kept");
    expect(s.report.keptForSecrets).toEqual([]);
  });

  it("an unparseable local structured file is kept under force", async () => {
    const dest = path.join(dir, "c.json");
    await fsp.writeFile(dest, '{"env":{"K":"real"},');
    const s = session("source", true);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: `{"env":{"K":"${R}"}}` })).toBe("kept");
    expect(s.report.keptForSecrets).toEqual([dest]);
  });
});

describe("repair keeps local-only keys", () => {
  it("a broken config.toml keeps its local [projects] table", async () => {
    const dest = path.join(dir, "config.toml");
    await fsp.writeFile(dest, `model = "${R}"\n\n[projects."/home/u/p"]\ntrust_level = "trusted"\n`);
    const s = session("follower");
    expect(await placeFile(ctxOf(s), { bucket: "codex", dest, content: 'model = "o3"\n' })).toBe("written");
    expect(parseToml(await fsp.readFile(dest, "utf8"))).toEqual({
      model: "o3",
      projects: { "/home/u/p": { trust_level: "trusted" } },
    });
    expect(s.report.missingSecrets).toEqual([]);
  });

  const brokenSettings =
    `{\n  "env": {\n    "FEATURE_SWITCH": "${R}",\n    "API_TOKEN": "${R}"\n  },\n` +
    `  "permissions": {\n    "allow": ["Bash(ls)"]\n  }\n}\n`;
  const repoSettings = `{"env":{"FEATURE_SWITCH":"1","API_TOKEN":"${R}"},"model":"opus"}`;

  it("a broken settings.json keeps its permissions block and takes the repo's real switch", async () => {
    const dest = path.join(dir, "settings.json");
    await fsp.writeFile(dest, brokenSettings);
    const s = session("source", false);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: repoSettings })).toBe("written");
    const out = await fsp.readFile(dest, "utf8");
    expect(JSON.parse(out)).toEqual({ env: { FEATURE_SWITCH: "1" }, permissions: { allow: ["Bash(ls)"] } });
    expect(out.startsWith('{\n  "env"')).toBe(true);
    expect(out.endsWith("}\n")).toBe(true);
    expect(s.report.missingSecrets).toEqual([{ tool: "claude", file: dest, keyPath: ["env", "API_TOKEN"] }]);
  });

  it("under force the repo-based merge still applies", async () => {
    const dest = path.join(dir, "settings.json");
    await fsp.writeFile(dest, brokenSettings);
    const s = session("source", true);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: repoSettings })).toBe("written");
    expect(JSON.parse(await fsp.readFile(dest, "utf8"))).toEqual({ env: { FEATURE_SWITCH: "1" }, model: "opus" });
  });
});

describe("arbella's own autobackup hook is ignored when comparing", () => {
  const ours = { hooks: [{ type: "command", command: `arbella push --auto >/dev/null 2>&1 & # ${HOOK_TAG}` }] };
  const user = { hooks: [{ type: "command", command: "echo hello" }] };
  const repo = JSON.stringify({ model: "opus", hooks: { SessionStart: [user] } }, null, 4) + "\n";
  const local = JSON.stringify({ model: "opus", hooks: { SessionStart: [user, ours] } }, null, 2) + "\n";

  it("settings.json equal to the repo plus arbella's hook is identical", async () => {
    const dest = path.join(dir, "settings.json");
    await fsp.writeFile(dest, local);
    const s = session("source", true);
    const req = { bucket: "claude", dest, content: repo, repoPath: "claude/files/settings.json" };
    expect(await placeFile(ctxOf(s), req)).toBe("identical");
    expect(await fsp.readFile(dest, "utf8")).toBe(local);
    expect(s.ledger.files[dest]).toBe(sha256(local));
  });

  it("only for the two hook files, and only when the rest is equal", async () => {
    const dest = path.join(dir, "settings.json");
    await fsp.writeFile(dest, local);
    const s = session("source", false);
    expect(await placeFile(ctxOf(s), { bucket: "claude", dest, content: repo, repoPath: "claude/files/x.json" })).toBe(
      "kept",
    );
    const other = repo.replace("opus", "sonnet");
    const req = { bucket: "claude", dest, content: other, repoPath: "claude/files/settings.json" };
    expect(await placeFile(ctxOf(s), req)).toBe("kept");
  });
});

describe("ledger", () => {
  it("round-trips through save/load and holds only hashes and key paths", async () => {
    const file = path.join(dir, "sub", "pull-ledger.json");
    const l: Ledger = { version: 1, files: { "/a": sha256("x") }, missingSecrets: [{ tool: "t", file: "/a", keyPath: ["k"] }] };
    await saveLedger(fs, l, file);
    expect(await loadLedger(fs, file)).toEqual(l);
  });

  it("absent file gives an empty ledger", async () => {
    expect(await loadLedger(fs, path.join(dir, "none.json"))).toEqual(emptyLedger());
  });

  it("corrupt ledger gives empty plus a warning", async () => {
    const file = path.join(dir, "l.json");
    await fsp.writeFile(file, "{nope");
    expect(await loadLedger(fs, file, log)).toEqual(emptyLedger());
    await fsp.writeFile(file, '{"version":2}');
    expect(await loadLedger(fs, file, log)).toEqual(emptyLedger());
    expect(warns).toHaveLength(2);
    expect(await loadLedger(fs, file)).toEqual(emptyLedger());
  });

  it("stillMissing re-checks the file", async () => {
    const f = path.join(dir, "s.json");
    const e = { tool: "t", file: f, keyPath: ["env", "K"] };
    expect(await stillMissing(fs, e)).toBe(false);
    await fsp.writeFile(f, "{nope");
    expect(await stillMissing(fs, e)).toBe(true);
    await fsp.writeFile(f, '{"env":{}}');
    expect(await stillMissing(fs, e)).toBe(true);
    await fsp.writeFile(f, `{"env":{"K":"${R}"}}`);
    expect(await stillMissing(fs, e)).toBe(true);
    await fsp.writeFile(f, '{"env":{"K":"real"}}');
    expect(await stillMissing(fs, e)).toBe(false);
    await fsp.writeFile(f, '{"env":"str"}');
    expect(await stillMissing(fs, e)).toBe(true);
    const t = path.join(dir, "c.toml");
    await fsp.writeFile(t, '[env]\nK = "v"\n');
    expect(await stillMissing(fs, { ...e, file: t })).toBe(false);
    await fsp.writeFile(t, "= bad");
    expect(await stillMissing(fs, { ...e, file: t })).toBe(true);
    const o = path.join(dir, "o.md");
    await fsp.writeFile(o, "x");
    expect(await stillMissing(fs, { ...e, file: o })).toBe(true);
  });
});

describe("formatPullSummary", () => {
  const home = "/home/u";
  it("lists counts, caps kept paths at 20, hints per role, redacted files and missing secrets", () => {
    const kept = Array.from({ length: 23 }, (_, i) => `${home}/.claude/f${i}`);
    const lines = formatPullSummary(
      {
        tools: { claude: { written: 3, identical: 2, kept }, codex: { written: 1, identical: 0, kept: [] } },
        redactedText: [`${home}/.codex/AGENTS.md`],
        missingSecrets: [{ tool: "codex", file: `${home}/.codex/config.toml`, keyPath: ["mcp_servers", "u", "env", "P"] }],
        keptForSecrets: [],
      },
      "follower",
      home,
    );
    const text = lines.join("\n");
    expect(text).toContain("claude: 3 written, 2 unchanged, 23 kept");
    expect(text).toContain("codex: 1 written, 0 unchanged, 0 kept");
    expect(text).toContain("~/.claude/f19");
    expect(text).not.toContain("f20");
    expect(text).toContain("… and 3 more");
    expect(text).toContain("changed locally");
    expect(text).toContain("arbella pull --force");
    expect(text).toContain(`~/.codex/AGENTS.md`);
    expect(text).toContain(R);
    expect(lines).toContain("secret missing: codex mcp u → P");
    expect(text).not.toContain(home + "/");
  });

  it("caps the files still containing the marker at 20", () => {
    const redactedText = Array.from({ length: 25 }, (_, i) => `${home}/.claude/r${i}.md`);
    const text = formatPullSummary(
      { tools: {}, redactedText, missingSecrets: [], keptForSecrets: [] },
      "source",
      home,
    ).join("\n");
    expect(text).toContain("~/.claude/r19.md");
    expect(text).not.toContain("r20.md");
    expect(text).toContain("… and 5 more");
  });

  it("uses source wording, shows exactly 20 without a tail, and a bare home path", () => {
    const kept = [home, ...Array.from({ length: 19 }, (_, i) => `/other/${i}`)];
    const text = formatPullSummary(
      { tools: { t: { written: 0, identical: 0, kept } }, redactedText: [], missingSecrets: [], keptForSecrets: [] },
      "source",
      home,
    ).join("\n");
    expect(text).toContain("differs from repo");
    expect(text).not.toContain("more");
    expect(text).toContain("~");
  });

  it("prints nothing about kept files when there are none", () => {
    const lines = formatPullSummary(
      { tools: { t: { written: 1, identical: 0, kept: [] } }, redactedText: [], missingSecrets: [], keptForSecrets: [] },
      "source",
      home,
    );
    expect(lines.join("\n")).not.toContain("--force");
  });

  it("prints files kept for their secrets as their own block, without the --force hint", () => {
    const script = `${home}/.claude/hooks/run.sh`;
    const lines = formatPullSummary(
      {
        tools: { claude: { written: 0, identical: 0, kept: [script] } },
        redactedText: [],
        missingSecrets: [{ tool: "claude", file: `${home}/.claude/settings.json`, keyPath: ["env", "API_TOKEN"] }],
        keptForSecrets: [script],
      },
      "source",
      home,
    );
    expect(lines).toContain("claude: 0 written, 0 unchanged, 1 kept");
    expect(lines).toContain(`  kept (has real values where the repo has ${R}): ~/.claude/hooks/run.sh`);
    expect(lines).toContain("  remove the local file (or MCP server entry) to take the repo version");
    expect(lines).not.toContain("  kept ~/.claude/hooks/run.sh");
    expect(lines.join("\n")).not.toContain("--force");
    expect(lines).toContain("secret missing: claude ~/.claude/settings.json → env.API_TOKEN");
  });

  it("strips control characters from printed paths", () => {
    const evil = `${home}/.claude/a\x1b[2J\nfake line`;
    const lines = formatPullSummary(
      { tools: { t: { written: 0, identical: 0, kept: [evil] } }, redactedText: [evil], missingSecrets: [], keptForSecrets: [] },
      "source",
      home,
    );
    expect(lines).toContain("  kept ~/.claude/a[2Jfake line");
    for (const l of lines) expect(l).not.toMatch(/\p{C}/u);
  });
});
