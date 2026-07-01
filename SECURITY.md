# Security Policy

Arbella's whole job is to move your AI-tool setup between machines **without ever
carrying a secret into a Git repo**. Security reports are taken seriously.

## Supported versions

Arbella is pre-1.0 and ships from `main`. Only the latest published `0.1.x`
release on npm receives security fixes.

| Version | Supported |
| --- | --- |
| latest `0.1.x` | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's [private vulnerability
reporting](https://github.com/Fafoooo/arbella/security/advisories/new) (the
**Security → Report a vulnerability** tab on the repository). That keeps the
details confidential until a fix is available.

When you report, please include:

- the Arbella version (`arbella --version`) and your OS;
- what the issue is and the impact (e.g. a path where a credential could reach
  the repo, or a sanitizer/denylist bypass);
- steps to reproduce, ideally with a minimal redacted example;
- any suggested fix, if you have one.

You can expect an acknowledgement within a few days. Once a fix ships, the
advisory is published and your report is credited unless you ask otherwise.

## What counts as a vulnerability here

Arbella's threat model centers on **secret containment**. High-value reports
include:

- a credential file or token-shaped value reaching the backup repo despite the
  denylist / sanitizer (this is the single most important class of bug — there is
  a build-time test guarding it, and a bypass is serious);
- a token Arbella holds for itself being written outside its `0600` local file
  (into the repo, a logged command, or a Git remote URL);
- path-traversal or arbitrary-write during `pull`/restore that escapes the tool
  home or safety-backup directory;
- command injection through captured config, repo contents, or CLI arguments.

## Handling secrets in a report

Never paste a real token or credential into a report. Redact secret values and
replace machine paths with placeholders, exactly as Arbella itself does.
