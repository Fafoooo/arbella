/**
 * Template variable set + ordering for the templater.
 *
 * The templater converts machine-specific values (home directory, username,
 * tool home, OS) into stable {{TOKEN}} placeholders on capture, and expands
 * those placeholders back into this machine's values on restore. This module
 * owns:
 *   - building the variable map for the current machine (buildVariables),
 *   - building it explicitly for tests / a known restore target (makeVariables),
 *   - and the canonical *ordering* of replacements (orderedReplacements).
 *
 * ORDERING RULE (critical): when collapsing machine values into tokens we must
 * apply the most-specific (longest) value FIRST. TOOL_HOME (e.g. ~/.claude) is a
 * child of HOME, so if HOME were applied first the result would be
 * "{{HOME}}/.claude" instead of the desired "{{TOOL_HOME}}". Ordering by value
 * length, descending, guarantees nested paths collapse to the tightest token.
 *
 * This file is dependency-light: it only touches the OS abstraction
 * (src/platform/os.ts) so home/user/OS are never hardcoded.
 */

import type { OS, TemplateVariables } from "../../types.js";
import { detectOS, homeDir, userName } from "../../platform/os.js";

/** Wrap a bare variable name in the placeholder braces: "HOME" -> "{{HOME}}". */
export function tokenFor(name: string): string {
  return `{{${name}}}`;
}

/**
 * Build the variable map from the LIVE machine via the OS abstraction.
 * `toolHome` is optional; pass it when processing a specific tool's home so its
 * path collapses to {{TOOL_HOME}} (more specific than {{HOME}}).
 */
export function buildVariables(toolHome?: string): TemplateVariables {
  return makeVariables(homeDir(), userName(), detectOS(), toolHome);
}

/**
 * Build the variable map explicitly. Used by tests and by restore when the
 * target machine's identity is known/derived rather than read live.
 *
 * Empty/whitespace-only values are dropped so the templater never tries to
 * match the empty string (which would otherwise corrupt every position in the
 * text). TOOL_HOME is only set when a non-empty value is supplied.
 */
export function makeVariables(
  home: string,
  user: string,
  os: OS,
  toolHome?: string,
): TemplateVariables {
  const vars: TemplateVariables = {
    HOME: home,
    USER: user,
    OS: os,
  };
  if (toolHome !== undefined && toolHome.trim() !== "") {
    vars.TOOL_HOME = toolHome;
  }
  return vars;
}

/** One ordered replacement directive: a placeholder token and its machine value. */
export interface Replacement {
  /** Placeholder form, e.g. "{{TOOL_HOME}}". */
  token: string;
  /** The machine value this token stands in for, e.g. "/Users/fab/.claude". */
  value: string;
  /** The bare variable name, e.g. "TOOL_HOME" (handy for special-casing OS). */
  name: string;
}

/**
 * Produce the ordered [{ token, value, name }] list the templater iterates.
 *
 * Order: by value length DESCENDING (most-specific path first), with a stable
 * tie-break on the variable name so output is deterministic. Variables with an
 * empty/whitespace-only value are skipped entirely.
 *
 * This list contains EVERY defined variable (HOME, USER, OS, TOOL_HOME, and any
 * forward-compatible extras). `fromTemplate` iterates the whole list to expand
 * placeholders; `toTemplate` iterates it too but applies its own per-variable
 * matching strategy (path-aware vs. word-boundary) and intentionally skips the
 * OS enum value — see index.ts.
 */
export function orderedReplacements(vars: TemplateVariables): Replacement[] {
  const entries: Replacement[] = [];
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value !== "string") continue;
    if (value.trim() === "") continue;
    entries.push({ token: tokenFor(name), value, name });
  }
  entries.sort((a, b) => {
    if (b.value.length !== a.value.length) return b.value.length - a.value.length;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return entries;
}
