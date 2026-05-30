# BUILD_CONTRACT.md — arbella

**Authoritative spec for all module agents.** The FOUNDATION (this document's author)
has created the project skeleton, shared types, schemas, the Adapter interface, the
OS layer, and the fs/log utilities. Your job, as a module agent, is to implement the
file(s) assigned to you so that the whole tree **compiles and runs together**.

Read this entire file before writing code. The signatures here are normative.

---

## 0. Ground rules (NON-NEGOTIABLE)

1. **ESM + NodeNext.** Every **local** import specifier MUST end in `.js`:
   `import { fs } from "../utils/fs.js";`. Importing `"../utils/fs"` (no `.js`) **breaks the build**.
   Bare package imports (`"zod"`, `"execa"`, `"commander"`, `"picocolors"`, `"smol-toml"`,
   `"@clack/prompts"`, `"node:fs/promises"`) do **not** take `.js`.
2. **Only write the `.ts` files assigned to you.** Do not run `npm install`, do not run a
   build, do not edit another module's files, do not touch `package.json`/`tsconfig.json`/
   `tsup.config.ts`/`vitest.config.ts` or the foundation files in §1.
3. **Import shared types from `src/types.ts`** (`import type { ... } from "../types.js"` —
   depth adjusted per directory). Do not redefine `ToolId`, `CaptureResult`, etc.
4. **No hardcoded paths.** Resolve home/config/data/tool-home via `src/platform/os.ts`.
   Use `node:path.join` — never string-concat path separators.
5. **No system clock in library code.** If you need a timestamp, accept it as a parameter
   (ISO string). Only command-layer entrypoints (`src/commands/*`, `src/index.ts`) and the
   autobackup throttle may call `Date.now()` / `new Date()`, and they pass it inward.
6. **Security (HARD):** never print, copy, log, or commit secret values. Files matching the
   denylist are excluded wholesale; values matching secret patterns are redacted. Settings
   are sanitized **before** they are written to the repo working tree.
7. **Cross-OS:** machine paths in captured content become `{{HOME}}`/`{{USER}}` placeholders
   via the templater on capture, and are re-expanded on restore.
8. **Graceful absence:** every read of a tool dir / optional file must tolerate "not there"
   (return empty / skip + warn), never throw an unhandled error. Cursor in particular may be
   entirely absent.
9. **Style:** prefer `async`/`await`; surface non-fatal issues by pushing to a `warnings`
   array or `log.warn(...)`, not by throwing. Throw only on truly unrecoverable errors.

---

## 1. Files the FOUNDATION already created — DO NOT MODIFY

These are done and are the contract surface you build against. Read them; don't edit them.

| Path | What it gives you |
|---|---|
| `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `.npmignore` | Project config. ESM, NodeNext, strict, tsup shebang banner, vitest node env. |
| `src/types.ts` | All shared domain types (see §2). Import from `"../types.js"`. |
| `src/core/config/schema.ts` | `arbellaConfigSchema`, `ArbellaConfig`, `DEFAULT_CONFIG`, `repoConfigSchema`, `RepoConfig`. |
| `src/core/manifest/schema.ts` | Zod schemas + types for manifests/meta + `MANIFEST_SCHEMA_VERSION`. |
| `src/adapters/adapter.interface.ts` | `Adapter`, `CoreServices`, `CaptureContext`, `RestoreContext`, `RestoreData`. |
| `src/platform/os.ts` | `detectOS`, `homeDir`, `userName`, `configDir`, `dataDir`, `toolHomeDir`, `installCommandFor`, `cliBinaryName`, `InstallCommand`. |
| `src/utils/log.ts` | `log` (default + named), `setVerbose`. Implements `Logger`. Writes to **stderr**. |
| `src/utils/fs.ts` | `fs` (default + named). Implements `FsService` over `node:fs/promises`. |

---

## 2. The shared type vocabulary (from `src/types.ts`)

Memorize these shapes; your signatures must match them exactly.

```ts
type ToolId = "claude" | "codex" | "cursor";
type OS = "darwin" | "linux" | "win32";
type SourceOfTruth = "local" | "repo";
type AutoBackupMode = "off" | "session-start" | "daily";
type RepoProvider = "github" | "gitlab" | "generic";

interface CapturedFile   { repoPath: string; content: string; mode?: number; binary?: boolean; }
interface CapturedSymlink{ repoPath: string; target: string; }

interface SecretRef {
  tool: ToolId; source: string; key: string; description: string;
  kind: "file" | "value";
}

interface CaptureResult {
  tool: ToolId;
  files: CapturedFile[];
  symlinks: CapturedSymlink[];
  manifest: ToolManifest;
  secrets: SecretRef[];
  warnings: string[];
}

interface RestoreAction {
  type: "write-file" | "write-symlink" | "install-cli" | "install-plugin"
      | "add-marketplace" | "install-skill" | "install-npm-global"
      | "enable-plugin" | "run-command";
  tool: ToolId | "system";
  targetPath?: string;
  description: string;
  overwrites?: boolean;
}
interface RestorePlan {
  tools: ToolId[]; actions: RestoreAction[];
  missingClis: ToolId[]; willBackupExisting: boolean;
}

interface SanitizeResult { content: string; found: SecretRef[]; changed: boolean; }
interface TemplateVariables { HOME: string; USER: string; OS: OS; TOOL_HOME?: string; [k: string]: string | undefined; }

interface Logger { info; success; warn; error; step; debug (all (msg:string)=>void) }
interface FsService { read, readBytes, write, writeBytes, copy, ensureDir, exists, rmrf,
                      list, isSymlink, readLink, symlink, statKind } // see src/utils/fs.ts for exact sigs
interface SanitizerService { isDenied(rel:string):boolean;
                             sanitizeText(content,tool,source):SanitizeResult;
                             sanitizeJson(obj,tool,source):{value:unknown;found:SecretRef[]} }
interface TemplaterService { toTemplate(content,vars):string; fromTemplate(content,vars):string }
```

Manifest/meta types (from `src/core/manifest/schema.ts`):

```ts
PluginEntry      { id; name; marketplace?; version?; enabled=true; scope="user"|"project"; projectPath? }
MarketplaceEntry { id; sourceType:"github"|"git"|"local"; source }   // github=>"owner/repo", git=>URL
SkillEntry       { name; source:"skills.sh"|"frozen"; installCommand?; symlinked=false }
NpmGlobalEntry   { package; version? }
ToolManifest     { tool; plugins[]; marketplaces[]; skills[]; npmGlobals[]; enabledPlugins:Record<string,boolean> }
ArbellaMeta     { schemaVersion; arbellaVersion; tools[]; options{includeSecrets;includeMemories;sourceOfTruth};
                   createdAt; sharedInstructions=false }
```

Config types (from `src/core/config/schema.ts`):

```ts
RepoConfig     { provider:"github"|"gitlab"|"generic"; url; localPath }
ArbellaConfig { repo:RepoConfig; sourceOfTruth; autoBackup; includeSecrets; includeMemories; tools:ToolId[] }
DEFAULT_CONFIG : ArbellaConfig
```

Adapter contexts (from `src/adapters/adapter.interface.ts`):

```ts
CoreServices    { fs; log; sanitizer; templater; vars:TemplateVariables; os:OS }
CaptureContext  extends CoreServices { toolHome; includeSecrets; includeMemories; dryRun }
RestoreContext  extends CoreServices { toolHome; repoToolDir; repoRoot; sourceOfTruth; dryRun }
RestoreData     { manifest:ToolManifest; files:CapturedFile[]; symlinks:CapturedSymlink[] }
Adapter         { id; displayName; detect(); isCliInstalled(); installCli(os);
                  capture(ctx):Promise<CaptureResult>; restore(ctx,data):Promise<void> }
```

---

## 3. The backup-repo layout (what gets committed to the user's private repo)

This is the on-disk contract between `capture` (writes it) and `restore` (reads it). Use
exactly these `repoPath` prefixes. **POSIX separators only** in `repoPath`.

```
<repoRoot>/
├── arbella.json                 # ArbellaMeta (top-level)
├── README.md                     # auto-generated restore instructions
├── .gitignore                    # secret denylist baked in
├── shared/
│   └── instructions.md           # R9: the single shared CLAUDE.md == AGENTS.md (only if identical)
├── claude/
│   ├── files/...                 # frozen files, mirrors ~/.claude subtree (sanitized + templated)
│   └── manifest.json             # ToolManifest for claude
├── codex/
│   ├── files/...                 # frozen files, mirrors ~/.codex subtree
│   └── manifest.json
├── cursor/
│   ├── files/...                 # frozen files (present only if cursor existed)
│   └── manifest.json
└── memories/                     # OPTIONAL (R13), only when includeMemories
    ├── claude/...
    └── codex/...
```

**Convention:** an adapter capturing file `~/.claude/X` emits `CapturedFile.repoPath =
"claude/files/X"`. Symlinks under `~/.claude/skills/<n>` emit `CapturedSymlink.repoPath =
"claude/files/skills/<n>"` with `target` preserved verbatim. The restore side strips the
`"<tool>/files/"` prefix to map back onto `toolHome`.

---

## 4. VERIFIED machine reality (so adapter specs match the real files)

The foundation inspected this machine. Adapters MUST handle these exact shapes.

### Claude (`~/.claude/`)
- **Keep (frozen):** `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents/*.md`,
  `commands/`, `hooks/` (shell + py, executable — preserve mode), `statusline/`,
  `skills/` (MIXED: real dirs **and** relative symlinks `-> ../../.agents/skills/<name>`).
- **Manifest (reinstall):** `plugins/installed_plugins.json` (shape below),
  `plugins/known_marketplaces.json` (shape below), `enabledPlugins` (from settings.json),
  skills.sh symlinks, npm globals.
- **EXCLUDE (denylist):** `.credentials.json`, `.claude.json` (177KB, mode 600 — has tokens +
  projects; sanitize if ever included, default exclude), `history.jsonl`, `projects/`,
  `sessions/`, `shell-snapshots/`, `statsig/`, `cost-tally.json`, `stats-cache.json`,
  `telemetry/`, `cache/`, `paste-cache/`, `file-history/`, `ide/`, `debug/`, `downloads/`,
  `*.sqlite`, `.DS_Store`, `.last-*`, `mcp-needs-auth-cache.json`, `backups/`, `plans/`,
  `checkpoints/`, `tasks/`, `teams/`, `session-env/`, `chrome/`.

`installed_plugins.json` (real):
```jsonc
{ "version": 2, "plugins": {
  "superpowers@claude-plugins-official": [
    { "scope":"user"|"project", "installPath":"...", "projectPath":"...", // optional
      "version":"5.1.0", "installedAt":"...", "lastUpdated":"...", "gitCommitSha":"..." } ] } }
```
Map each `id` (the key) → `PluginEntry` { id, name=left-of-@, marketplace=right-of-@,
version, scope=entry.scope, projectPath?=entry.projectPath }. Only `scope:"user"` plugins are
auto-reinstalled on restore.

`known_marketplaces.json` (real):
```jsonc
{ "claude-plugins-official": {
    "source": { "source":"github", "repo":"anthropics/claude-plugins-official" },
    "installLocation":"...", "lastUpdated":"..." } }
```
Map each key → `MarketplaceEntry` { id=key, sourceType=source.source ("github"),
source=source.repo ("owner/repo") }.

`enabledPlugins` in settings.json (real): `{ "superpowers@claude-plugins-official": true, ... }`
→ feeds `ToolManifest.enabledPlugins`.

### Codex (`~/.codex/`)
- **Keep (frozen):** `config.toml` (settings + sections — sanitize, see §7), `AGENTS.md`,
  `agents/*.toml`, `hooks/` (+ `hooks.json`), `rules/`, `prompts/`, `skills/`,
  `vendor_imports/`, `memories/` (only if includeMemories).
- **Manifest:** `[plugins."name@mp"] { enabled=true }`, `[marketplaces.name] { source_type,
  source }`, npm globals.
- **EXCLUDE (denylist):** `auth.json`, `history.jsonl`, `*.sqlite` (+ `-shm`/`-wal`:
  `goals_*.sqlite`, `logs_*.sqlite`, `state_*.sqlite`), `log/`, `sessions/`,
  `shell_snapshots/`, `cache/`, `models_cache.json`, `.tmp/`, `tmp/`, `.DS_Store`,
  `installation_id`, `external_agent_session_imports.json`, `session_index.jsonl`,
  `.codex-global-state.json`, `version.json`, `.personality_migration`.

`config.toml` real top-level + sections (sanitizer/configToml must handle):
```toml
approval_policy="on-request"  model="gpt-5.5"  sandbox_mode="workspace-write"  # scalars: keep
[features] ...                                  # keep
[marketplaces.claude-plugins-official]          # -> MarketplaceEntry
  source_type="git"  source="https://github.com/.../claude-plugins-official.git"
[plugins."superpowers@claude-plugins-official"] enabled=true   # -> PluginEntry
[mcp_servers.NAME] command=..., args=[...], env={...}          # SECRET RISK: template paths, redact env values
[projects."/abs/path"] trust_level="trusted"                   # template path in the KEY
[shell_environment_policy.set] KEY="VALUE"                     # possible secrets -> sanitize values
[hooks.state."...:hash"] trusted_hash="sha256:..."             # machine-specific -> STRIP on capture
[tui.*], [notice.*]                                            # keep
```

### Cursor (`~/.cursor/`) — may be absent
- `mcp.json` (real: `{ "mcpServers": { "trigger": { "command":"npx", "args":[...] } } }`),
  project-level `.cursor/rules`. Desktop app; CLI may be absent on Linux.
- Adapter must return `detect()===false` gracefully if the dir is missing.

### skills.sh mechanism
- Global skills live in `~/.agents/skills/<name>`; the tool's `skills/<name>` is a **relative
  symlink** `-> ../../.agents/skills/<name>`. `~/.agents/.skill-lock.json` = `{ version, skills:{} }`.
- **Reinstallable** skill (symlink into `~/.agents/skills`) → `SkillEntry { source:"skills.sh",
  symlinked:true, installCommand:"npx skills add <name>" }`. **Real dir** (not a symlink) →
  freeze its files AND record `SkillEntry { source:"frozen", symlinked:false }`.

### CLIs / globals (verified)
- Present: `claude`, `codex`, `gh`, `brew`, `npm`. Absent: `cursor`, `glab`, `winget`.
- `npm ls -g --depth=0` includes e.g. `@google/gemini-cli`, `skillsgate`, `@openai/codex`.
  `greppy` is at `~/.local/bin/greppy` (NOT an npm global → it will not appear in npm list;
  do not assume npm can reinstall it — record only what npm reports).
- **R9 fact:** on this machine `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` are
  **byte-identical** (1810 bytes). The shared-instructions path applies.

---

## 5. Module specifications

For each file: **path · responsibility · exact signatures · libraries**. Implement exactly
these exports (you may add private helpers). All local imports end in `.js`.

> Depth note: import paths below are written from the file's own directory. E.g. from
> `src/core/sanitizer/index.ts`, types are `"../../types.js"`; from `src/commands/backup.ts`
> they are `"../types.js"`.

---

### 5.1 Sanitizer — `src/core/sanitizer/`

#### `src/core/sanitizer/denylist.ts`
**Responsibility:** the static denylist of path globs/segments that must NEVER leave the
machine, per-tool, plus a matcher. **Libraries:** none (pure).
```ts
/** Glob-ish patterns relative to a tool home. Support "*" and trailing "/" (dir). */
export const COMMON_DENY: readonly string[];                 // e.g. ".DS_Store", "*.sqlite", "*.sqlite-*"
export const CLAUDE_DENY: readonly string[];                 // see §4 Claude EXCLUDE list
export const CODEX_DENY: readonly string[];                  // see §4 Codex EXCLUDE list
export const CURSOR_DENY: readonly string[];
export function denylistFor(tool: ToolId): string[];         // COMMON + tool-specific
/** True if relativePath (POSIX, relative to tool home) matches any pattern. */
export function matchesDeny(relativePath: string, patterns: string[]): boolean;
```
Matching rules: a pattern ending in `/` matches that dir and everything under it; `*` is a
single-segment wildcard; an exact segment matches if it appears as any path segment OR equals
the basename. Keep it small and deterministic; no external glob lib.

#### `src/core/sanitizer/patterns.ts`
**Responsibility:** regexes for secret VALUES + redaction marker. **Libraries:** none.
```ts
export const REDACTED = "{{REDACTED}}";
export interface SecretPattern { name: string; regex: RegExp; }
export const SECRET_PATTERNS: readonly SecretPattern[];      // sk-..., ghp_..., Bearer xxx,
                                                             // "api_key": "...", AKIA..., xoxb-..., -----BEGIN ... KEY-----
/** Keys whose values are always secret regardless of value shape. */
export const SECRET_KEY_NAMES: readonly string[];            // "api_key","apikey","token","secret","password",
                                                             // "authorization","access_token","refresh_token","client_secret"
/** True if a JSON/TOML key name denotes a secret value. */
export function isSecretKey(key: string): boolean;
```

#### `src/core/sanitizer/index.ts`
**Responsibility:** the `SanitizerService` implementation. **Libraries:** none (operates on
strings/objects; TOML/JSON parsing is done by callers and re-serialized by them, EXCEPT
sanitizeJson which clones a parsed object).
```ts
import type { SanitizerService, SanitizeResult, SecretRef, ToolId } from "../../types.js";
/** Factory. Pass the tool to bind the right denylist; service methods still take tool too. */
export function createSanitizer(): SanitizerService;
// Behavior:
//  isDenied(rel): matchesDeny(rel, denylistFor(tool-from-source? )) -> see note
//  sanitizeText: replace every SECRET_PATTERNS match with REDACTED; collect SecretRef{kind:"value"}
//  sanitizeJson: deep-clone; for any key where isSecretKey(key) OR value matches a pattern,
//                replace value with REDACTED; collect SecretRefs. Recurse objects/arrays.
export const sanitizer: SanitizerService;                    // default singleton built via createSanitizer()
export default sanitizer;
```
> `isDenied(rel)` is tool-agnostic at call sites that already know the tool; implement it as
> `matchesDeny(rel, denylistFor("claude").concat(denylistFor("codex"),...))`? **No** — keep it
> simple: `isDenied` checks against `COMMON_DENY` only, and adapters additionally call
> `matchesDeny(rel, denylistFor(tool))` themselves. Document whichever you implement in a
> top-of-file comment; the **adapter capture modules** are the ones that own per-tool deny
> filtering (they import `denylistFor` + `matchesDeny` directly). Prefer that split.

---

### 5.2 Templater — `src/core/templater/`

#### `src/core/templater/variables.ts`
**Responsibility:** build the `TemplateVariables` for the current machine + the ordered token
table. **Libraries:** `src/platform/os.ts`.
```ts
import type { TemplateVariables, OS } from "../../types.js";
/** Build vars from the live machine (uses os.ts). toolHome optional. */
export function buildVariables(toolHome?: string): TemplateVariables;
/** Build vars explicitly (for tests / restore on a known target). */
export function makeVariables(home: string, user: string, os: OS, toolHome?: string): TemplateVariables;
/**
 * Replacement order matters: longest/most-specific path first (TOOL_HOME before HOME)
 * so nested paths template correctly. Export the ordered list of [token, value] used by index.ts.
 */
export function orderedReplacements(vars: TemplateVariables): Array<{ token: string; value: string }>;
// token format is "{{NAME}}"
```

#### `src/core/templater/index.ts`
**Responsibility:** `TemplaterService` impl — machine value ⇄ `{{TOKEN}}`. Must be
Windows-safe (normalize `\` vs `/` when matching HOME). **Libraries:** `node:path` if needed.
```ts
import type { TemplaterService, TemplateVariables } from "../../types.js";
export function createTemplater(): TemplaterService;
// toTemplate:  replace each value (HOME, USER, TOOL_HOME, ...) with its {{TOKEN}},
//              most-specific first; also handle backslash-path variants of HOME on win32.
// fromTemplate: replace each {{TOKEN}} with the machine value.
export const templater: TemplaterService;
export default templater;
```

---

### 5.3 Manifest — `src/core/manifest/index.ts`
**Responsibility:** build/read/validate manifests + meta; **own the shared-instructions (R9)
helper**; serialize JSON deterministically. **Libraries:** `zod` (via the schemas),
`node:path`. **No clock** — `createdAt` comes in as a param.
```ts
import { type ToolManifest, type ArbellaMeta, type ArbellaConfig,
         type ToolId, type CapturedFile } from "../../types.js";
import { toolManifestSchema, arbellaMetaSchema } from "./schema.js";

/** Empty manifest for a tool (all arrays empty). */
export function emptyManifest(tool: ToolId): ToolManifest;

/** Validate + parse a manifest read from disk (throws ZodError on bad data). */
export function parseManifest(json: unknown): ToolManifest;       // toolManifestSchema.parse
export function parseMeta(json: unknown): ArbellaMeta;           // arbellaMetaSchema.parse

/** Build top-level meta. createdAt MUST be supplied by the caller (ISO string). */
export function buildArbellaMeta(args: {
  arbellaVersion: string;
  tools: ToolId[];
  config: ArbellaConfig;
  createdAt: string;                 // caller passes new Date().toISOString()
  sharedInstructions: boolean;
}): ArbellaMeta;

/** Deterministic JSON (2-space, stable key order) for committing. */
export function serialize(value: unknown): string;

/* ---- Shared instructions (R9) — single source of truth lives HERE ---- */
/** Repo path where the shared instructions file is stored. */
export const SHARED_INSTRUCTIONS_REPO_PATH = "shared/instructions.md";
/**
 * Decide R9: given the (already-read) contents of CLAUDE.md and AGENTS.md (either may be
 * undefined if absent), return whether they are byte-identical and should be shared.
 * Pure + synchronous; no fs here.
 */
export function shouldShareInstructions(claudeMd?: string, agentsMd?: string): boolean;
/**
 * Produce the CapturedFile for the shared instructions (repoPath = SHARED_INSTRUCTIONS_REPO_PATH).
 * Caller only invokes when shouldShareInstructions() is true.
 */
export function buildSharedInstructionsFile(content: string): CapturedFile;
/** The two destinations the shared file deploys to on restore (relative to each tool home). */
export function sharedInstructionsTargets(): Array<{ tool: ToolId; relPath: string }>;
//   -> [ { tool:"claude", relPath:"CLAUDE.md" }, { tool:"codex", relPath:"AGENTS.md" } ]
//   (cursor rule deployment is handled by the cursor adapter reading shared/instructions.md)
```
> **R9 end-to-end:** `backup.ts` reads both files, calls `shouldShareInstructions`. If true:
> it emits ONE `buildSharedInstructionsFile(...)` into the repo and sets
> `meta.sharedInstructions=true`, and the claude/codex adapters MUST NOT also emit their own
> `CLAUDE.md`/`AGENTS.md` frozen file (backup.ts tells them via a flag — see 5.10/5.13 capture
> note). If false, each adapter freezes its own file normally. On restore, when
> `meta.sharedInstructions`, `restore.ts` reads `shared/instructions.md` and writes it to BOTH
> targets from `sharedInstructionsTargets()` (+ cursor adapter writes a Cursor rule).

---

### 5.4 Repo — `src/core/repo/`

#### `src/core/repo/git.ts`
**Responsibility:** thin git wrapper via `execa`. **Libraries:** `execa`, `src/utils/log.ts`.
All functions take an absolute `cwd` (the repo working copy).
```ts
export interface GitResult { stdout: string; stderr: string; exitCode: number; }
export function isGitRepo(cwd: string): Promise<boolean>;
export function gitInit(cwd: string): Promise<void>;
export function clone(url: string, dest: string): Promise<void>;
export function addAll(cwd: string): Promise<void>;
/** Returns false (no commit made) when there is nothing staged. */
export function commit(cwd: string, message: string): Promise<boolean>;
export function push(cwd: string, opts?: { setUpstream?: boolean; branch?: string }): Promise<void>;
export function pull(cwd: string): Promise<void>;
export function currentBranch(cwd: string): Promise<string>;
export function setRemote(cwd: string, name: string, url: string): Promise<void>;
/** Porcelain status -> list of { path, status }. Empty => clean. */
export function status(cwd: string): Promise<Array<{ path: string; status: string }>>;
/** name-status diff vs HEAD (for `status` command). */
export function diffNameStatus(cwd: string): Promise<Array<{ path: string; status: string }>>;
export function hasRemote(cwd: string, name?: string): Promise<boolean>;
```
Use `execa("git", [...], { cwd })`; never shell-interpolate. Treat non-zero exit as throw
EXCEPT where a boolean is the documented return.

#### `src/core/repo/providers/github.ts`, `gitlab.ts`, `generic.ts`
**Responsibility:** create the remote repo if missing (R11). **Libraries:** `execa`
(`gh`/`glab`), `src/utils/log.ts`. Each exports a `RepoProviderApi`:
```ts
// shared shape (define in index.ts and import, OR re-declare identically):
export interface RepoProviderApi {
  readonly id: RepoProvider;                                   // "github"|"gitlab"|"generic"
  /** Is the provider CLI available (gh/glab)? generic => always true. */
  isAvailable(): Promise<boolean>;
  /** Does the named repo already exist for the user? generic => assume true (no API). */
  repoExists(name: string): Promise<boolean>;
  /** Create a PRIVATE repo named `name`; return its clone URL (ssh or https). */
  createRepo(name: string, opts?: { private?: boolean; description?: string }): Promise<string>;
  /** Resolve "owner/name" or full URL into a clone URL for this provider. */
  resolveUrl(input: string): Promise<string>;
}
export const githubProvider: RepoProviderApi;   // uses `gh repo create <name> --private`
export const gitlabProvider: RepoProviderApi;   // uses `glab repo create <name> --private`
export const genericProvider: RepoProviderApi;  // no creation; resolveUrl returns input as-is
```
github: `gh repo create <name> --private --clone=false`, then read URL via
`gh repo view <name> --json sshUrl,url`. gitlab analogous with `glab`. **Default repos to
PRIVATE** (R11) — never create public.

#### `src/core/repo/index.ts`
**Responsibility:** orchestrate provider selection + high-level repo ops used by commands.
**Libraries:** the above + `src/core/config`.
```ts
import type { RepoProvider } from "../../types.js";
import type { RepoConfig } from "../config/schema.js";
export interface RepoProviderApi { /* same shape as above */ }
export function getProvider(provider: RepoProvider): RepoProviderApi;
/** Ensure the configured repo exists locally (clone if needed) at repo.localPath. */
export function ensureLocalClone(repo: RepoConfig): Promise<void>;
/** init helper: create remote if missing, return the resolved RepoConfig. */
export function ensureRemoteRepo(args: {
  provider: RepoProvider; name: string; localPath: string;
}): Promise<RepoConfig>;
/** backup helper: stage+commit+push. Returns false if nothing changed. message supplied by caller. */
export function commitAndPush(localPath: string, message: string): Promise<boolean>;
/** status helper: changed paths local vs repo. */
export function repoStatus(localPath: string): Promise<Array<{ path: string; status: string }>>;
```

---

### 5.5 Secrets — `src/core/secrets/index.ts`
**Responsibility:** LOCAL-ONLY encrypted transfer of secret files (R5). scrypt + aes-256-gcm
via `node:crypto`. Never touches git. **Libraries:** `node:crypto`, `node:fs/promises` (or
`src/utils/fs.ts`), `src/platform/os.ts`.
```ts
import type { ToolId, SecretRef } from "../../types.js";

/** One secret file bundled into the blob. content is base64 of the raw bytes. */
export interface SecretBundleEntry { tool: ToolId; relPath: string; contentB64: string; mode?: number; }
export interface SecretBundle { version: 1; createdAt: string; entries: SecretBundleEntry[]; }
//   createdAt supplied by caller.

/** Encrypt a bundle with a passphrase. Returns an opaque, self-describing blob (string).
 *  Format: base64 of [magic|salt(16)|iv(12)|authTag(16)|ciphertext]. */
export function encryptBundle(bundle: SecretBundle, passphrase: string): string;

/** Decrypt a blob; throws on wrong passphrase / tampering (GCM auth fail). */
export function decryptBundle(blob: string, passphrase: string): SecretBundle;

/** Gather the actual secret files from disk into a bundle (reads tool homes).
 *  `refs` is the list of kind:"file" secrets discovered during capture. createdAt param. */
export function collectSecretFiles(refs: SecretRef[], createdAt: string): Promise<SecretBundle>;

/** Write bundle files back onto this machine's tool homes (used by `secrets import`). */
export function applySecretBundle(bundle: SecretBundle): Promise<void>;

/** crypto params (exported for tests). */
export const SCRYPT_PARAMS: { N: number; r: number; p: number; keyLen: 32 };
```
Crypto detail (normative): `key = scryptSync(passphrase, salt, 32, SCRYPT_PARAMS)`;
`cipher = createCipheriv("aes-256-gcm", key, iv)`; prepend a short magic (e.g. `"RSK1"`) for
format detection; concatenate `salt|iv|authTag|ciphertext`; base64 the whole thing. Decrypt
verifies the auth tag and throws a clear error on mismatch (wrong passphrase).

---

### 5.6 Auto-backup — `src/core/autobackup/`

#### `src/core/autobackup/throttle.ts`
**Responsibility:** decide whether a backup should run now, persisting last-run time in a
stamp file under `dataDir()`. **Libraries:** `src/utils/fs.ts`, `src/platform/os.ts`.
**Clock allowed here** but prefer taking `now` as a param for testability.
```ts
import type { AutoBackupMode } from "../../types.js";
export const STAMP_FILE: string;                              // path.join(dataDir(),"autobackup.json")
export interface ThrottleState { lastRunIso: string | null; }
export function readState(): Promise<ThrottleState>;
export function writeState(nowIso: string): Promise<void>;
/** Pure decision: given mode, last run, and now, should we back up?
 *  off=>false; session-start=>true unless < MIN_GAP since last (default 5 min);
 *  daily=>true if >=24h since last (or never). */
export function shouldRun(mode: AutoBackupMode, lastRunIso: string | null, nowIso: string): boolean;
export const MIN_SESSION_GAP_MS: number;                      // 5*60*1000
export const DAILY_GAP_MS: number;                            // 24*60*60*1000
```

#### `src/core/autobackup/hook.ts`
**Responsibility:** generate + install/uninstall the throttled SessionStart hook into Claude
(`~/.claude/settings.json` `hooks.SessionStart`) and Codex (`~/.codex/hooks.json`). The hook
invokes `arbella backup --auto` in the background. **Libraries:** `src/utils/fs.ts`,
`src/platform/os.ts`, `src/adapters/*/paths` (for settings locations) — but to avoid coupling,
read/modify the JSON directly here.
```ts
/** The command the hook runs (background, non-blocking). */
export function hookCommand(): string;     // e.g. `arbella backup --auto >/dev/null 2>&1 &` (POSIX)
                                           //      and a win32 variant; pick per detectOS()
/** Install the SessionStart hook into both tools' settings (idempotent). */
export function installHook(mode: AutoBackupMode): Promise<void>;
/** Remove any arbella-installed SessionStart hook from both tools. */
export function uninstallHook(): Promise<void>;
/** Tag used to find/replace our hook entries so we never clobber user hooks. */
export const HOOK_TAG: string;             // e.g. "arbella-autobackup"
```
Insert hook objects shaped like the real Claude hooks (`{ hooks:[{ type:"command",
command:"..." }] }`) under `SessionStart`. Mark them with `HOOK_TAG` (e.g. embed in a comment
field or a recognizable command substring) so uninstall is surgical. Codex uses `hooks.json`
with the same nested shape (see §4).

#### `src/core/autobackup/index.ts`
**Responsibility:** glue — `maybeRunBackup` called by `backup --auto`; configure cadence.
**Libraries:** throttle + hook + config.
```ts
import type { AutoBackupMode } from "../../types.js";
/** Apply a cadence: persists to config (caller writes config) + (un)installs the hook. */
export function setAutoBackup(mode: AutoBackupMode): Promise<void>;
/** Used by `backup --auto`: returns true if throttle says go; updates stamp when it returns true.
 *  `now` injected for tests; default to new Date().toISOString() at the call site in the command. */
export function maybeRunBackup(mode: AutoBackupMode, nowIso: string): Promise<boolean>;
```

---

### 5.7 Config — `src/core/config/index.ts`
**Responsibility:** load/save/locate the arbella config; validate via schema; provide
defaults. **Libraries:** `zod` (schema), `src/utils/fs.ts`, `src/platform/os.ts`.
```ts
import { type ArbellaConfig, arbellaConfigSchema, DEFAULT_CONFIG } from "./schema.js";
export function configPath(): string;                         // path.join(configDir(),"config.json")
export function configExists(): Promise<boolean>;
/** Load + validate. Throws (with a friendly message) if file missing or invalid. */
export function loadConfig(): Promise<ArbellaConfig>;
/** Load or return DEFAULT_CONFIG if absent (no throw). */
export function loadConfigOrDefault(): Promise<ArbellaConfig>;
export function saveConfig(config: ArbellaConfig): Promise<void>;   // ensureDir + write serialized
/** Shallow-merge a partial update over the current (or default) config and save. */
export function updateConfig(patch: Partial<ArbellaConfig>): Promise<ArbellaConfig>;
```

---

### 5.8–5.10 Claude adapter — `src/adapters/claude/`

#### `src/adapters/claude/paths.ts`
**Responsibility:** all Claude path knowledge. **Libraries:** `node:path`, `src/platform/os.ts`.
```ts
export function home(): string;                                // toolHomeDir("claude")
export const REPO_PREFIX = "claude/files";                     // CapturedFile.repoPath prefix
export interface ClaudePaths {
  home: string; settings: string; settingsLocal: string; claudeMd: string;
  agentsDir: string; commandsDir: string; hooksDir: string; statuslineDir: string;
  skillsDir: string; pluginsDir: string;
  installedPlugins: string; knownMarketplaces: string;
}
export function paths(home?: string): ClaudePaths;             // absolute paths; home overridable for tests
/** Files/dirs to FREEZE (relative to home), in capture order. */
export const FROZEN_PATHS: readonly string[];                  // ["settings.json","settings.local.json","CLAUDE.md","agents","commands","hooks","statusline","skills"]
```

#### `src/adapters/claude/plugins.ts`
**Responsibility:** parse Claude plugin/marketplace JSON + settings.enabledPlugins into
manifest entries; build restore install steps. **Libraries:** `src/utils/fs.ts`, manifest types.
```ts
import type { PluginEntry, MarketplaceEntry } from "../../types.js";
/** Parse installed_plugins.json content -> entries (only well-formed ones; skip malformed). */
export function parseInstalledPlugins(json: unknown): PluginEntry[];
/** Parse known_marketplaces.json content -> entries. */
export function parseKnownMarketplaces(json: unknown): MarketplaceEntry[];
/** Extract enabledPlugins map from settings.json object. */
export function extractEnabledPlugins(settings: unknown): Record<string, boolean>;
/** Build the shell commands to re-add a marketplace + install a plugin (for restore).
 *  Use the documented `claude` CLI plugin commands. Return argv arrays for execa. */
export function marketplaceAddArgs(m: MarketplaceEntry): string[];   // e.g. ["plugin","marketplace","add", m.source]
export function pluginInstallArgs(p: PluginEntry): string[];         // e.g. ["plugin","install", p.id]
```
> Only reinstall `scope:"user"` plugins. Re-enabling is driven by `enabledPlugins` written
> back into settings.json by the restore module (which is the source of truth Claude reads).

#### `src/adapters/claude/capture.ts`
**Responsibility:** produce `CaptureResult` for Claude. **Libraries:** fs/sanitizer/templater
(from ctx), `node:path`, `./paths.js`, `./plugins.js`, sanitizer denylist helpers.
```ts
import type { CaptureContext } from "../adapter.interface.js";
import type { CaptureResult } from "../../types.js";
/** @param opts.skipInstructions when true (R9 shared), do NOT emit CLAUDE.md as a frozen file. */
export function capture(ctx: CaptureContext, opts?: { skipInstructions?: boolean }): Promise<CaptureResult>;
```
Algorithm: walk `FROZEN_PATHS`; for each existing path, recurse files; for each file compute
`rel` (relative to home), skip if `matchesDeny(rel, denylistFor("claude"))`; read; if textual,
`sanitizer.sanitizeText` then `templater.toTemplate(.., ctx.vars)`; emit `CapturedFile`
(repoPath=`claude/files/<rel>`, preserve `mode` for hooks/statusline executables). For symlinks
under `skills/`, emit `CapturedSymlink` and a `SkillEntry{source:"skills.sh",symlinked:true}`;
for real skill dirs, freeze files + `SkillEntry{source:"frozen"}`. Read plugin JSONs →
`manifest.plugins/marketplaces`; settings → `enabledPlugins`. Collect npm globals via a shared
helper (see 5.14 `listNpmGlobals`). Denylisted-but-present secret files → push `SecretRef`
(kind:"file"). Honor `ctx.dryRun` (compute, emit nothing extra). Respect `opts.skipInstructions`.

#### `src/adapters/claude/restore.ts`
**Responsibility:** place frozen files + symlinks onto target, reinstall plugins/marketplaces/
skills, write back enabledPlugins. **Libraries:** fs/templater (ctx), `execa`, `./plugins.js`,
`src/platform/install.ts` (for npm/cli).
```ts
import type { RestoreContext, RestoreData } from "../adapter.interface.js";
export function restore(ctx: RestoreContext, data: RestoreData): Promise<void>;
/** Build the plan fragment (actions) without executing — used by restore.ts for --dry-run. */
export function planActions(ctx: RestoreContext, data: RestoreData): Promise<import("../../types.js").RestoreAction[]>;
```
On execute (not dryRun): write each file (strip `claude/files/` → join `toolHome`),
`templater.fromTemplate` first, restore mode; recreate symlinks; `claude plugin marketplace
add` then `claude plugin install` for user-scope entries; merge `enabledPlugins` into the
restored settings.json; run skill installs (`npx skills add <name>`). All install steps go
through 5.13 helpers and must `isCliInstalled`-guard. Respect `ctx.sourceOfTruth` for overwrite.

#### `src/adapters/claude/index.ts`
**Responsibility:** the `Adapter` object for Claude. **Libraries:** the above + os.ts.
```ts
import type { Adapter } from "../adapter.interface.js";
export const claudeAdapter: Adapter;
export default claudeAdapter;
// id:"claude", displayName:"Claude Code".
// detect: fs.exists(home) && (exists(settings.json) || exists(CLAUDE.md) || list(agents).length)
// isCliInstalled: which(cliBinaryName("claude"))  [use src/platform/install.ts helper]
// installCli(os): runInstall(installCommandFor("claude", os))
// capture/restore delegate to ./capture.js and ./restore.js
```

---

### 5.11–5.13 Codex adapter — `src/adapters/codex/`

#### `src/adapters/codex/paths.ts`
Mirror of claude/paths for `~/.codex`. **Libraries:** `node:path`, os.ts.
```ts
export function home(): string;                                // toolHomeDir("codex")
export const REPO_PREFIX = "codex/files";
export interface CodexPaths {
  home: string; configToml: string; agentsMd: string; agentsDir: string;
  hooksDir: string; hooksJson: string; rulesDir: string; promptsDir: string;
  skillsDir: string; memoriesDir: string; vendorImportsDir: string;
}
export function paths(home?: string): CodexPaths;
export const FROZEN_PATHS: readonly string[];                  // ["config.toml","AGENTS.md","agents","hooks","hooks.json","rules","prompts","skills","vendor_imports"]  (+"memories" gated by includeMemories)
```

#### `src/adapters/codex/configToml.ts`
**Responsibility:** parse + sanitize + template + re-serialize `config.toml`; extract
plugins/marketplaces. **Libraries:** `smol-toml` (`parse`, `stringify`), sanitizer patterns,
templater. **This is the trickiest module — read §4 Codex carefully.**
```ts
import type { PluginEntry, MarketplaceEntry, SecretRef } from "../../types.js";
import type { TemplaterService, TemplateVariables } from "../../types.js";
export interface ParsedCodexConfig {
  /** The sanitized + templated TOML text to store (for the frozen config.toml). */
  sanitizedToml: string;
  plugins: PluginEntry[];          // from [plugins."name@mp"] { enabled }
  marketplaces: MarketplaceEntry[];// from [marketplaces.name] { source_type, source }
  secrets: SecretRef[];            // any redacted values (mcp_servers env, shell_env policy)
}
/** Parse raw config.toml text and produce sanitized output + manifest pieces.
 *  - redact secret VALUES under [mcp_servers.*] (env, headers, tokens) and
 *    [shell_environment_policy.set] using sanitizer patterns/isSecretKey;
 *  - template absolute paths in values AND in [projects."PATH"] keys via templater.toTemplate;
 *  - DROP [hooks.state.*] tables (machine-specific trusted hashes);
 *  - keep scalars/[features]/[tui]/[notice]. */
export function processConfigToml(
  raw: string, templater: TemplaterService, vars: TemplateVariables,
): ParsedCodexConfig;
/** Inverse for restore: expand {{TOKENS}} back to machine paths. (Plugins/marketplaces are
 *  reinstalled via CLI, not by editing the toml, but paths in projects/mcp must be rehydrated.) */
export function rehydrateConfigToml(stored: string, templater: TemplaterService, vars: TemplateVariables): string;
```
> `smol-toml.parse(raw)` → object; mutate; `smol-toml.stringify(obj)`. When dropping
> `[hooks.state.*]`, delete the `hooks.state` table (and `hooks` if it becomes empty). Preserve
> dotted-key/quoted-key sections; smol-toml round-trips these. Test with the real file shape.

#### `src/adapters/codex/capture.ts`
Like claude/capture but for Codex, using `processConfigToml` for `config.toml` and freezing the
rest of `FROZEN_PATHS`. Same `opts.skipInstructions` semantics for `AGENTS.md` (R9).
```ts
import type { CaptureContext } from "../adapter.interface.js";
import type { CaptureResult } from "../../types.js";
export function capture(ctx: CaptureContext, opts?: { skipInstructions?: boolean }): Promise<CaptureResult>;
```
`auth.json`, sqlite, history, etc. are denylisted (push SecretRef for `auth.json`). Gate
`memories/` on `ctx.includeMemories` (emit under `codex/files/memories/...`).

#### `src/adapters/codex/restore.ts`
Like claude/restore: write frozen files (rehydrate config.toml paths), reinstall codex plugins/
marketplaces via the `codex` CLI, recreate skills. **Libraries:** fs/templater (ctx), execa,
install helpers.
```ts
import type { RestoreContext, RestoreData } from "../adapter.interface.js";
export function restore(ctx: RestoreContext, data: RestoreData): Promise<void>;
export function planActions(ctx: RestoreContext, data: RestoreData): Promise<import("../../types.js").RestoreAction[]>;
```
Codex plugin/marketplace reinstall argv: use the `codex` CLI's plugin commands; if unknown,
fall back to writing the `[plugins.*]`/`[marketplaces.*]` tables into the restored config.toml
and `log.warn` that a `codex` re-sync may be needed. Document whichever you choose at top of file.

#### `src/adapters/codex/index.ts`
```ts
import type { Adapter } from "../adapter.interface.js";
export const codexAdapter: Adapter;
export default codexAdapter;
// id:"codex", displayName:"Codex".
// detect: exists(home) && (exists(config.toml) || exists(AGENTS.md))
// isCliInstalled: which("codex"); installCli(os): runInstall(installCommandFor("codex",os))
```

---

### 5.14 Cursor adapter — `src/adapters/cursor/`

#### `src/adapters/cursor/paths.ts`
```ts
export function home(): string;                                // toolHomeDir("cursor")
export const REPO_PREFIX = "cursor/files";
export interface CursorPaths { home: string; mcpJson: string; skillsDir: string; rulesDir: string; }
export function paths(home?: string): CursorPaths;
export const FROZEN_PATHS: readonly string[];                  // ["mcp.json"]  (rules are project-level; global is minimal)
```

#### `src/adapters/cursor/index.ts`
**Responsibility:** the Cursor `Adapter`, **fully graceful when absent**. Capture is best-effort
(mcp.json only). On restore it also writes the Cursor rule from shared instructions when R9 is
active (the restore command passes the shared content in via RestoreData.files containing a
`cursor/files/.cursor/rules/...` entry, OR the adapter reads `repoRoot/shared/instructions.md`).
**Libraries:** fs (ctx), os.ts, install helpers (cursor app install per §os.ts).
```ts
import type { Adapter } from "../adapter.interface.js";
export const cursorAdapter: Adapter;
export default cursorAdapter;
// id:"cursor", displayName:"Cursor".
// detect: exists(home)  (returns false cleanly if missing)
// isCliInstalled: which("cursor")  (often false -> installCli uses brew/winget; null on linux => warn+skip)
// capture: if !detect -> return empty CaptureResult with a warning; else freeze mcp.json (sanitized+templated)
// restore: write frozen files; if meta.sharedInstructions, also write ~/.cursor rule or note it.
```
Keep cursor minimal; do not block backup/restore of other tools if cursor is missing.

---

### 5.15 Adapter registry — `src/adapters/registry.ts`
**Responsibility:** central list + lookups. (Foundation reserved this; implement it as a module
agent if assigned, else commands import the three adapters directly.) **Libraries:** the three
adapter index modules.
```ts
import type { Adapter } from "./adapter.interface.js";
import type { ToolId } from "../types.js";
export const adapters: readonly Adapter[];                    // [claudeAdapter, codexAdapter, cursorAdapter]
export function getAdapter(id: ToolId): Adapter;             // throws if unknown
export function adaptersFor(ids: ToolId[]): Adapter[];
/** detect() across all; returns the ids actually present on this machine. */
export function detectPresent(): Promise<ToolId[]>;
```

---

### 5.16 Platform install — `src/platform/install.ts`
**Responsibility:** run install commands + a `which` probe. **Libraries:** `execa`,
`src/platform/os.ts`, `src/utils/log.ts`.
```ts
import type { OS, ToolId } from "../types.js";
import type { InstallCommand } from "./os.js";
/** True if `bin` resolves on PATH (uses `command -v` on POSIX, `where` on win32). */
export function which(bin: string): Promise<boolean>;
/** Execute an InstallCommand (from installCommandFor). No-op + warn if null was passed. */
export function runInstall(cmd: InstallCommand | null): Promise<void>;
/** Convenience: ensure a tool's CLI is installed for `os` (skip if `which` already true). */
export function ensureCli(tool: ToolId, os: OS): Promise<void>;
/** Install a global npm package: `npm install -g <pkg>`. */
export function npmInstallGlobal(pkg: string): Promise<void>;
/** List installed global npm packages -> [{ package, version }]. Parses `npm ls -g --json`.
 *  Tolerant of npm's exit codes/noise; returns [] on failure. */
export function listNpmGlobals(): Promise<Array<{ package: string; version?: string }>>;
```
> `listNpmGlobals` is the shared source for `ToolManifest.npmGlobals` in BOTH adapters. Filter
> out npm/corepack itself. Note: tools installed outside npm (e.g. greppy at ~/.local/bin) will
> NOT appear here — that's expected; do not fabricate entries.

---

### 5.17 Commands — `src/commands/`
All commands are thin: parse flags (commander passes options in), assemble `CoreServices`,
call core/adapters, print via `log`. They MAY use `@clack/prompts` for interactivity and MAY
call the clock (pass timestamps inward). Each exports a `register(program)` that attaches a
subcommand, AND a directly-callable `run(opts)` for testing.

Shared helper every command uses to build services:
```ts
// implement once (suggest src/commands/_context.ts OR inline) — but the agreed shape is:
function buildCoreServices(toolHome: string): CoreServices  // { fs, log, sanitizer, templater, vars:buildVariables(toolHome), os:detectOS() }
```
> If you own `init.ts`, also create `src/commands/_context.ts` exporting `buildCoreServices`
> and `buildCaptureContext`/`buildRestoreContext` factories, and document it here in a follow-up.
> Otherwise, each command may construct `CoreServices` inline (sanitizer/templater singletons +
> fs/log defaults + buildVariables + detectOS).

#### `src/commands/init.ts` (R11, R12, R4-config)
```ts
import type { Command } from "commander";
export function register(program: Command): void;            // `arbella init`
export interface InitOptions { provider?: RepoProvider; repo?: string; tools?: string;
  sourceOfTruth?: SourceOfTruth; autoBackup?: AutoBackupMode; yes?: boolean; }
export function run(opts: InitOptions): Promise<void>;
```
Flow: prompt (clack) provider + repo name + tools + sourceOfTruth + autoBackup (unless flags/
`--yes`); `ensureRemoteRepo` (create PRIVATE if missing); `ensureLocalClone`; write config via
`saveConfig`; `setAutoBackup(mode)` to install the hook. Never print tokens.

#### `src/commands/backup.ts` (R3 backup, R4 --auto, R9, R14 --dry-run)
```ts
import type { Command } from "commander";
export interface BackupOptions { dryRun?: boolean; auto?: boolean; message?: string; }
export function register(program: Command): void;            // `arbella backup`
export function run(opts: BackupOptions): Promise<void>;
```
Flow: `loadConfig`; if `--auto`, gate via `maybeRunBackup(config.autoBackup, nowIso)` and exit
quietly if throttled; ensure local clone; read CLAUDE.md+AGENTS.md and decide R9
(`shouldShareInstructions`); for each configured tool call `adapter.capture(ctx,
{skipInstructions: sharing})`; write all `CapturedFile`s + symlinks + `manifest.json` per tool
into `repo.localPath` (respect `dryRun`: print plan, write nothing); write `shared/
instructions.md` once if sharing; write `arbella.json` via `buildArbellaMeta({createdAt:new
Date().toISOString(), ...})`; generate repo README; `commitAndPush` with `opts.message ??
"arbella backup <iso>"`. `--dry-run` prints the file list + secrets summary and does NOT
commit.

#### `src/commands/restore.ts` (R6, R8, R9, R12, R14)
```ts
import type { Command } from "commander";
export interface RestoreOptions { dryRun?: boolean; repo?: string; tools?: string; force?: boolean; }
export function register(program: Command): void;            // `arbella restore [repoUrl]`
export function run(repoUrl: string | undefined, opts: RestoreOptions): Promise<void>;
```
Flow: resolve repo (arg or config); `ensureLocalClone` / `pull`; parse `arbella.json`
(`parseMeta`); build `RestorePlan` (actions from each adapter's `planActions` + `missingClis`
via `which`); if `dryRun`, print plan and STOP; else **R14 safety backup**: copy existing
`~/.claude`/`~/.codex` to a timestamped dir (see 5.18) BEFORE writing; auto-install missing
CLIs (`ensureCli`); for each tool load `RestoreData` (files from `repo/<tool>/files`, manifest
via `parseManifest`) and call `adapter.restore(ctx, data)`; if `meta.sharedInstructions`, write
`shared/instructions.md` to each `sharedInstructionsTargets()` destination (+ cursor rule);
print a re-login reminder (auth.json/.credentials.json were NOT carried).

#### `src/commands/status.ts` (R3 status)
```ts
import type { Command } from "commander";
export interface StatusOptions { json?: boolean; }
export function register(program: Command): void;            // `arbella status`
export function run(opts: StatusOptions): Promise<void>;
```
Flow: `loadConfig`; ensure clone; run an in-memory capture (dryRun) for each tool, diff the
would-be repo files against what's committed (`repoStatus` + content compare); print a
human table (or JSON to **stdout** when `--json`). Show: changed/new/removed files, pending
manifest changes, and whether secrets would be excluded.

#### `src/commands/secrets.ts` (R5)
```ts
import type { Command } from "commander";
export interface SecretsExportOptions { out: string; }       // blob output path
export interface SecretsImportOptions { in: string; }        // blob input path
export function register(program: Command): void;            // `arbella secrets export|import`
export function runExport(opts: SecretsExportOptions): Promise<void>;
export function runImport(opts: SecretsImportOptions): Promise<void>;
```
export: discover secret files (re-run captures in a "list secrets" mode or scan denylist hits),
`collectSecretFiles(refs, new Date().toISOString())`, prompt passphrase (clack `password`),
`encryptBundle`, write blob to `opts.out`. import: read blob, prompt passphrase,
`decryptBundle`, `applySecretBundle`. NEVER touch git; NEVER print secret contents.

---

### 5.18 Safety backup helper (R14)
Used by `restore.ts`. **Owner:** whoever builds `restore.ts` (or a shared util). Suggested home:
`src/utils/fs.ts` already provides primitives; add a small function in restore or a new
`src/utils/safety.ts` is NOT pre-created — keep it inside `restore.ts` unless coordinated.
Behavior (normative):
```ts
// timestamped copy of an existing tool home before overwrite:
//   dest = path.join(dataDir(), "safety-backups", `${tool}-${iso.replace(/[:.]/g,"-")}`)
//   if exists(toolHome) -> fs.copy(toolHome, dest)
// return the dest paths for reporting. createdAt/iso passed in by the command.
```

---

### 5.19 CLI entry — `src/index.ts`
**Responsibility:** wire commander, global flags, dispatch. **Libraries:** `commander`,
`picocolors`, `src/utils/log.ts`, all command modules.
```ts
// no exports required; this is the bin entry. tsup adds the shebang banner.
// - new Command("arbella"); .version(pkgVersion); .description(...)
// - global option --verbose -> setVerbose(true)
// - register(program) from init/backup/restore/status/secrets
// - program.parseAsync(process.argv); top-level try/catch -> log.error + process.exit(1)
// - read version from package.json via a JSON import assertion OR a hardcoded const synced to 0.1.0
```
> ESM JSON import in NodeNext: `import pkg from "../package.json" with { type: "json" }` works at
> runtime under Node 18+, but `rootDir:"src"` means package.json is outside the compile root.
> SIMPLEST: define `const VERSION = "0.1.0";` in index.ts (kept in sync) to avoid bundler/
> rootDir issues. Do that.

---

## 6. Integration checklist (what "compiles together" means)

- Every local import ends in `.js`. ✅ (grep your file before finishing.)
- Public signatures match this contract exactly (names, params, return types).
- No module imports another module's **internal** (non-exported) symbols.
- Adapters depend only on injected `CoreServices` + their own `paths`/helpers + `execa`/
  `install` for CLI work — never on commands.
- `commands/*` are the only place that reads global flags and the clock (timestamps passed in).
- Schemas are the only place zod object shapes are defined; everyone else imports the types.
- Run mentally: `backup` → capture → write repo → commit; `restore` → plan → safety-backup →
  install CLIs → restore per tool → deploy shared instructions. All paths via `os.ts`.

---

## 7. Quick reference: who owns the shared-instructions (R9) flow
- **Decision + storage + targets:** `src/core/manifest/index.ts`
  (`shouldShareInstructions`, `buildSharedInstructionsFile`, `SHARED_INSTRUCTIONS_REPO_PATH`,
  `sharedInstructionsTargets`).
- **Capture side:** `backup.ts` decides; passes `{skipInstructions:true}` to claude+codex
  capture so they don't double-emit CLAUDE.md/AGENTS.md; writes `shared/instructions.md` once.
- **Restore side:** `restore.ts` reads `shared/instructions.md` when `meta.sharedInstructions`
  and writes to both targets; cursor adapter additionally writes a Cursor rule.
```
