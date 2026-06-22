/**
 * `arbella setup` — interactive, cross-OS dependency installer (P3).
 *
 * The plug-&-play front door: a single command that detects which of arbella's
 * known dependencies (git, gh, glab, claude, codex, cursor) are present and lets
 * the user install the missing ones in one pass. It is a thin, interactive shell
 * over the platform install layer (`src/platform/install.ts`), which owns ALL the
 * cross-OS "how do I install X on this machine" knowledge (npm / brew / winget /
 * apt-dnf-pacman + sudo). This module only renders the choices, drives the
 * @clack multiselect, and reports per-dependency results.
 *
 * Interactive flow:
 *   1. Probe every dependency on PATH (concurrently) via `checkInstalled`.
 *   2. Render a @clack multiselect of all dependencies, each labelled with its
 *      rationale + current "installed / not installed" state, PRE-CHECKING the
 *      ones that are both MISSING and RECOMMENDED (git is strongly recommended;
 *      gh/glab recommended; the tool CLIs are opt-in). Already-installed deps are
 *      shown but left unchecked (installing them is a no-op the layer reports as
 *      "already").
 *   3. Install the selected dependencies sequentially via `installMany` (each
 *      shells out with inherited stdio so the user sees real progress; a single
 *      failure does not abort the batch — every result is reported).
 *   4. Summarise: installed / already-present / skipped-unsupported / failed.
 *
 * Non-interactive use (CI, scripts, no TTY):
 *   - `--all`            : select EVERY dependency (subject to per-OS support).
 *   - `--recommended`    : select only the recommended-but-missing set.
 *   - `--deps a,b,c`     : select an explicit comma/space-separated id list.
 *   - `-y, --yes`        : do not prompt; install the resolved default set
 *                          (recommended-but-missing) unless another selector is
 *                          given. Also auto-confirms when stdin is not a TTY.
 *   - `--force`          : reinstall/upgrade even if a binary is already present.
 * When stdout/stdin is not a TTY and no selector flag is passed, setup behaves as
 * if `--yes` (install the recommended-but-missing set) rather than hanging on a
 * prompt that can never be answered.
 *
 * SECURITY: setup installs SOFTWARE only. It never sees, prints, or stores any
 * token or credential — authentication is a separate concern handled by
 * `core/auth` (which this module deliberately does NOT import). The only output
 * is dependency labels and install progress.
 *
 * No system clock is used here: setup performs no
 * time-stamped library decision; it only detects + installs.
 */

import type { Command } from "commander";
import * as clack from "@clack/prompts";

import {
  allDependencies,
  checkInstalled,
  DEPENDENCY_IDS,
  getDependency,
  installMany,
  type DependencyId,
  type DependencySpec,
  type InstallOutcome,
} from "../platform/install.js";
import { log } from "../utils/log.js";

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Flags accepted by `arbella setup`. All are optional; with none of them the
 * command runs the interactive multiselect (when attached to a TTY).
 */
export interface SetupOptions {
  /** Select every known dependency (subject to per-OS install support). */
  all?: boolean;
  /** Select only the recommended dependencies that are currently missing. */
  recommended?: boolean;
  /** Explicit comma/space-separated dependency id list (git,gh,glab,...). */
  deps?: string;
  /** Reinstall/upgrade even if a binary already resolves on PATH. */
  force?: boolean;
  /**
   * Do not prompt: install the resolved default set (recommended-but-missing, or
   * whatever a selector flag resolves to). Implied when stdin is not a TTY.
   */
  yes?: boolean;
}

/* -------------------------------------------------------------------------- */
/* commander registration                                                      */
/* -------------------------------------------------------------------------- */

/** Attach the `setup` subcommand to the program. */
export function register(program: Command): void {
  program
    .command("setup")
    .description(
      "Detect and install the tools arbella relies on (git, gh, glab) and the " +
        "AI CLIs it backs up (claude, codex, cursor, opencode, copilot, kilo) — cross-OS, in one pass.",
    )
    .option("--all", "select every known dependency (where installable on this OS)")
    .option(
      "--recommended",
      "select only the recommended dependencies that are missing",
    )
    .option(
      "--deps <list>",
      "comma/space-separated dependency ids to install (git,gh,glab,claude,codex,cursor)",
    )
    .option("--force", "reinstall/upgrade even if already present")
    .option(
      "-y, --yes",
      "non-interactive: install the recommended-but-missing set (or the selector flag's set) without prompting",
    )
    .action(async (opts: SetupOptions) => {
      await run(opts);
    });
}

/* -------------------------------------------------------------------------- */
/* run                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Execute the setup flow. Directly callable (for tests) without commander.
 *
 * Resolution order for "which dependencies to install":
 *   1. An explicit selector flag (`--deps` > `--all` > `--recommended`) — used
 *      verbatim, no prompt.
 *   2. Otherwise, when interactive: a multiselect pre-checked with the
 *      recommended-but-missing set.
 *   3. Otherwise (non-interactive / `--yes`): the recommended-but-missing set.
 */
export async function run(opts: SetupOptions): Promise<void> {
  clack.intro("arbella setup — install the tools you need");

  // 1. Probe every dependency on PATH up front (concurrent, never throws).
  const statusList = await checkInstalled(DEPENDENCY_IDS);
  const installed = new Map<DependencyId, boolean>(
    statusList.map((s) => [s.id, s.installed]),
  );

  clack.note(formatStatusSummary(installed), "Detected");

  // 2. Resolve the selection (flag-driven, else prompt, else default set).
  const selection = await resolveSelection(opts, installed);
  if (selection === undefined) return; // user cancelled

  if (selection.length === 0) {
    clack.outro("Nothing selected — no changes made.");
    return;
  }

  // 3. Install the selected dependencies sequentially (live, inherited stdio).
  clack.note(
    selection.map((id) => `• ${getDependency(id).label}`).join("\n"),
    `Installing ${selection.length} dependenc${selection.length === 1 ? "y" : "ies"}`,
  );

  const outcomes = await installMany(selection, { force: opts.force });

  // 4. Report per-dependency results + a final one-line verdict.
  reportOutcomes(outcomes);
  clack.outro(finalLine(outcomes));
}

/* -------------------------------------------------------------------------- */
/* Selection resolution                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Decide which dependencies to install. Returns the chosen ids, or `undefined`
 * when the user cancels an interactive prompt. An explicit selector flag wins and
 * skips prompting entirely; with no flag we prompt (TTY) or fall back to the
 * recommended-but-missing default (non-TTY / `--yes`).
 */
async function resolveSelection(
  opts: SetupOptions,
  installed: ReadonlyMap<DependencyId, boolean>,
): Promise<DependencyId[] | undefined> {
  // 2a. Explicit selectors (no prompt). Precedence: --deps > --all > --recommended.
  if (opts.deps && opts.deps.trim() !== "") {
    const ids = parseDepList(opts.deps);
    if (ids.length === 0) {
      throw new Error(
        `--deps "${opts.deps}" did not contain any known dependency ` +
          `(${DEPENDENCY_IDS.join(", ")}).`,
      );
    }
    return ids;
  }
  if (opts.all) {
    // Everything, regardless of current state (force may reinstall; otherwise the
    // install layer reports already-present ones as "already").
    return [...DEPENDENCY_IDS];
  }
  if (opts.recommended) {
    return recommendedMissing(installed);
  }

  // 2b. No selector flag: the default selection is "recommended but missing".
  const defaults = recommendedMissing(installed);

  // Non-interactive (no TTY) or --yes: take the default set without prompting.
  if (opts.yes || !isInteractive()) {
    if (defaults.length === 0) {
      log.info(
        "All recommended dependencies are already installed; nothing to do.",
      );
    }
    return defaults;
  }

  // 2c. Interactive multiselect, pre-checking the recommended-but-missing set.
  return promptSelection(installed, defaults);
}

/**
 * Render the @clack multiselect of every dependency and return the user's chosen
 * ids. Pre-checks `defaults` (recommended-but-missing). `required: false` so the
 * user can legitimately pick nothing (we treat that as "no changes"). Returns
 * `undefined` on cancel.
 */
async function promptSelection(
  installed: ReadonlyMap<DependencyId, boolean>,
  defaults: readonly DependencyId[],
): Promise<DependencyId[] | undefined> {
  const options = allDependencies().map((spec) => ({
    value: spec.id,
    label: spec.label,
    hint: optionHint(spec, installed.get(spec.id) === true),
  }));

  const picked = await clack.multiselect<typeof options, DependencyId>({
    message:
      "Select the tools to install (Space toggles, Enter confirms). " +
      "Recommended-but-missing ones are pre-checked.",
    options,
    initialValues: [...defaults],
    required: false,
  });

  if (clack.isCancel(picked)) {
    clack.cancel("Setup cancelled — no changes made.");
    return undefined;
  }
  return picked;
}

/* -------------------------------------------------------------------------- */
/* ensureDeps — on-demand installer for other commands (P3)                    */
/* -------------------------------------------------------------------------- */

/** Options for {@link ensureDeps}. */
export interface EnsureDepsOptions {
  /**
   * Skip the confirmation prompt and install missing dependencies directly. Also
   * implied when stdin is not a TTY (a prompt could not be answered). Callers that
   * already carry a `--yes` flag (init/restore) should forward it here.
   */
  yes?: boolean;
  /** Reinstall even if present (rarely needed; defaults to false). */
  force?: boolean;
  /**
   * Treat a still-missing dependency (declined / failed / unsupported) as FATAL:
   * throw with a clear, actionable message instead of returning `ok: false`. Use
   * for hard prerequisites the caller cannot proceed without (e.g. `git` before a
   * clone). Default false: the caller inspects the result and decides.
   */
  required?: boolean;
}

/** The result of an {@link ensureDeps} call. */
export interface EnsureDepsResult {
  /**
   * True if, after this call, every required dependency resolves on PATH (either
   * it was already present, or we installed it successfully).
   */
  ok: boolean;
  /** Required dependencies that were already installed before this call. */
  alreadyPresent: DependencyId[];
  /** Required dependencies we installed during this call. */
  installed: DependencyId[];
  /**
   * Required dependencies still missing afterwards: the user declined, the
   * install failed, or there is no install path on this OS. `ok` is false when
   * this is non-empty.
   */
  missing: DependencyId[];
  /** Per-dependency outcomes for anything we attempted to install. */
  outcomes: InstallOutcome[];
}

/**
 * Ensure a set of dependencies is installed, installing the missing ones on
 * demand. The on-ramp other commands use when they hit a hard requirement, e.g.
 * restore/init calling `ensureDeps(["git"])` (or `["git", "gh"]`) before touching
 * a private repo. Mirrors the "git/gh not found — install now? [Y/n]" UX.
 *
 * Behaviour:
 *   - Probes each required id; those already on PATH are returned in
 *     `alreadyPresent` and never re-installed (unless `force`).
 *   - If any are missing: when interactive and not `--yes`, asks a single
 *     confirm ("Install the missing dependencies now?"). When the user agrees (or
 *     `yes`/non-TTY), installs them via the platform layer; when they decline,
 *     returns with `ok: false` and the still-missing list so the caller can warn
 *     and continue or abort as it sees fit.
 *   - NEVER throws for "a dependency is missing/declined" — that is a result, not
 *     an error. (It can still surface a programmer error for an unknown id via
 *     `getDependency`.)
 *
 * This helper performs NO authentication and imports nothing from `core/auth`; it
 * only installs software.
 */
export async function ensureDeps(
  required: readonly DependencyId[],
  opts: EnsureDepsOptions = {},
): Promise<EnsureDepsResult> {
  // De-duplicate while preserving caller order, and validate ids early.
  const wanted = dedupe(required);
  for (const id of wanted) getDependency(id); // throws on an unknown id

  if (wanted.length === 0) {
    return {
      ok: true,
      alreadyPresent: [],
      installed: [],
      missing: [],
      outcomes: [],
    };
  }

  // Probe current state concurrently.
  const state = await checkInstalled(wanted);
  const alreadyPresent = state.filter((s) => s.installed).map((s) => s.id);
  const toInstall = state.filter((s) => !s.installed).map((s) => s.id);

  // Everything already there — nothing to do.
  if (toInstall.length === 0) {
    return {
      ok: true,
      alreadyPresent,
      installed: [],
      missing: [],
      outcomes: [],
    };
  }

  // Confirm before installing (unless told not to / non-interactive).
  const labels = toInstall.map((id) => getDependency(id).label);
  if (!opts.yes && isInteractive()) {
    const proceed = await clack.confirm({
      message:
        `${formatMissingList(labels)} not found. ` +
        `Install ${toInstall.length === 1 ? "it" : "them"} now?`,
      initialValue: true,
    });
    if (clack.isCancel(proceed) || proceed === false) {
      // User declined. Either hard-fail (required) or report what's still missing.
      if (opts.required) {
        throw new Error(
          `${formatMissingList(labels)} ${
            toInstall.length === 1 ? "is" : "are"
          } required to continue but ${
            toInstall.length === 1 ? "was" : "were"
          } not installed. Install ${
            toInstall.length === 1 ? "it" : "them"
          } (e.g. \`arbella setup --deps ${toInstall.join(",")}\`) and re-run.`,
        );
      }
      return {
        ok: false,
        alreadyPresent,
        installed: [],
        missing: toInstall,
        outcomes: [],
      };
    }
  } else {
    // Non-interactive: announce what we're about to install so output is legible.
    log.info(
      `${formatMissingList(labels)} not found; installing ${
        toInstall.length === 1 ? "it" : "them"
      }…`,
    );
  }

  // Install sequentially; classify each outcome.
  const outcomes = await installMany(toInstall, { force: opts.force });
  const installedNow: DependencyId[] = [];
  const stillMissing: DependencyId[] = [];
  for (const o of outcomes) {
    if (o.status === "installed" || o.status === "already") {
      installedNow.push(o.id);
    } else {
      // "failed" or "unsupported" — still not usable.
      stillMissing.push(o.id);
      if (o.message) log.warn(`${getDependency(o.id).label}: ${o.message}`);
    }
  }

  if (opts.required && stillMissing.length > 0) {
    const labels2 = stillMissing.map((id) => getDependency(id).label);
    throw new Error(
      `${formatMissingList(labels2)} ${
        stillMissing.length === 1 ? "is" : "are"
      } required to continue but could not be installed. ` +
        "See the messages above; install manually and re-run.",
    );
  }

  return {
    ok: stillMissing.length === 0,
    alreadyPresent,
    installed: installedNow,
    missing: stillMissing,
    outcomes,
  };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The recommended dependencies that are currently MISSING — the default
 * pre-checked / non-interactive selection. Order follows {@link DEPENDENCY_IDS}.
 */
function recommendedMissing(
  installed: ReadonlyMap<DependencyId, boolean>,
): DependencyId[] {
  return allDependencies()
    .filter((spec) => spec.recommended && installed.get(spec.id) !== true)
    .map((spec) => spec.id);
}

/** Parse a comma/space-separated id list into known, de-duplicated DependencyIds. */
function parseDepList(raw: string): DependencyId[] {
  const out: DependencyId[] = [];
  const seen = new Set<DependencyId>();
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim().toLowerCase();
    if (t === "") continue;
    if (isDependencyId(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Type guard for DependencyId, checked against the canonical id list. */
function isDependencyId(value: string): value is DependencyId {
  return (DEPENDENCY_IDS as readonly string[]).includes(value);
}

/** De-duplicate an id list, preserving first-seen order. */
function dedupe(ids: readonly DependencyId[]): DependencyId[] {
  const seen = new Set<DependencyId>();
  const out: DependencyId[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * True when we may interactively prompt. Requires BOTH a TTY stdin (to read the
 * answer) and a TTY stdout (so the prompt is visible) — in a pipe/CI either is
 * absent and we must fall back to non-interactive behaviour rather than hang.
 */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Per-checkbox hint: install state + the dependency's rationale (+ "strong"). */
function optionHint(spec: DependencySpec, isInstalled: boolean): string {
  const state = isInstalled ? "installed" : "not installed";
  const strong = spec.strong ? "strongly recommended — " : "";
  return `${state} · ${strong}${spec.why}`;
}

/** Render the up-front detection summary (one line per dependency). */
function formatStatusSummary(
  installed: ReadonlyMap<DependencyId, boolean>,
): string {
  return allDependencies()
    .map((spec) => {
      const mark = installed.get(spec.id) === true ? "✓ installed" : "✗ missing";
      return `${mark}  ${spec.label}`;
    })
    .join("\n");
}

/** Join human labels into a natural "A, B and C" / "X" fragment for prompts. */
function formatMissingList(labels: readonly string[]): string {
  if (labels.length === 0) return "(nothing)";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** Print one result line per attempted install, with an appropriate log level. */
function reportOutcomes(outcomes: readonly InstallOutcome[]): void {
  for (const o of outcomes) {
    const label = getDependency(o.id).label;
    switch (o.status) {
      case "installed":
        log.success(`${label}: installed.`);
        break;
      case "already":
        log.info(`${label}: already installed.`);
        break;
      case "unsupported":
        log.warn(`${label}: ${o.message ?? "no automatic install on this OS."}`);
        break;
      case "failed":
        log.error(`${label}: ${o.message ?? "install failed."}`);
        break;
    }
  }
}

/** One-line outro verdict summarising the batch. */
function finalLine(outcomes: readonly InstallOutcome[]): string {
  const n = (status: InstallOutcome["status"]): number =>
    outcomes.filter((o) => o.status === status).length;

  const parts: string[] = [];
  const installed = n("installed");
  const already = n("already");
  const unsupported = n("unsupported");
  const failed = n("failed");

  if (installed > 0) parts.push(`${installed} installed`);
  if (already > 0) parts.push(`${already} already present`);
  if (unsupported > 0) parts.push(`${unsupported} unsupported`);
  if (failed > 0) parts.push(`${failed} failed`);

  const summary = parts.length > 0 ? parts.join(", ") : "nothing to do";
  return failed > 0
    ? `Setup finished with problems (${summary}). See messages above.`
    : `Setup complete (${summary}).`;
}
