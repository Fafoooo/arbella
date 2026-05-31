<div align="center">

<img src="https://raw.githubusercontent.com/Fafoooo/arbella/main/assets/arbella.png" alt="The Arbella, flagship of the 1630 Winthrop Fleet" width="480">

# ⛵ Arbella

**Set up your AI coding tools once. Rebuild that setup on any machine.**

Backup and migration for your Claude Code and Codex setup — skills, subagents,
plugins, hooks, settings, memories — into a private Git repo you own.

[![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)
&nbsp;![Node](https://img.shields.io/badge/node-%E2%89%A518-43853d?logo=node.js&logoColor=white)
&nbsp;![Platforms](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-555)
&nbsp;![Status](https://img.shields.io/badge/status-v0.1-orange)

[Quick start](#quick-start) · [Commands](#commands) · [How sign-in works](#how-sign-in-works) · [Secrets](#secrets)

</div>

---

## The problem

You've spent months tuning Claude Code or Codex — custom skills, a stack of subagents, plugins, hooks, your `CLAUDE.md`. Then you get a new laptop and do it all again from scratch.

Arbella saves that whole setup into a private Git repo and puts it back on another machine with one command. Linux, macOS, Windows.

## Quick start

```sh
arbella setup       # install what arbella leans on (git, gh, the tool CLIs)
arbella init        # point it at a private repo, pick your options
arbella push        # snapshot your setup and push it

# later, on another machine:
arbella pull https://github.com/you/your-setup
```

## Install

Needs Node 18+.

```sh
npm install -g arbella
arbella --help
```

## What it does

```text
  push   ~/.claude · ~/.codex   ──▶   strip · template   ──▶   private repo
  pull   private repo           ──▶   install · place    ──▶   ~/.claude · ~/.codex
```

`push` reads the parts of your setup that matter, strips anything secret, swaps machine-specific paths for placeholders, and pushes the result to your repo. `pull` does the reverse: installs the CLIs you don't have, drops files back with this machine's paths, reinstalls plugins and skills, and wires your shared instructions into both Claude and Codex.

Two things it deliberately won't do:

- **Never commits secrets.** API keys, OAuth tokens, `auth.json`, `.credentials.json` — all excluded, no exceptions. You sign back in after a pull, or carry them yourself with [`arbella secrets`](#arbella-secrets).
- **Doesn't copy what it can reinstall.** Plugins and registry skills are saved as a list and pulled fresh, so the repo stays small and never goes stale.

Supported today: **Claude Code** and **Codex**, plus a **Cursor** adapter that quietly does nothing when Cursor isn't installed.

## Commands

| Command | What it does |
| --- | --- |
| [`arbella setup`](#arbella-setup) | Install git, the provider CLIs, and the AI tool CLIs |
| [`arbella init`](#arbella-init) | One-time wiring: pick a repo and your options |
| [`arbella push`](#arbella-push) | Snapshot your setup and push it — the everyday one |
| [`arbella pull <url>`](#arbella-pull) | Rebuild your setup on a fresh machine |
| [`arbella status`](#arbella-status) | Show what a push would change — read-only |
| [`arbella auth`](#arbella-auth) | Sign in to your repo host |
| [`arbella secrets`](#arbella-secrets) | Move credentials between machines, off Git |

Every prompt has a flag, so anything interactive can be scripted. `--dry-run` works wherever it makes sense.

### `arbella setup`

Checks what's installed and offers to fill the gaps — a checklist, so you tick what you actually use.

```sh
arbella setup                   # interactive checklist
arbella setup --all             # everything, no prompts
arbella setup --deps git,gh -y  # just these
```

- Covers **git** (required), **gh** / **glab** (handle sign-in for you), and the AI CLIs (**claude**, **codex**, **cursor**).
- Installs through your system's package manager: apt, dnf, or pacman on Linux, Homebrew on macOS, winget on Windows.
- `init` and `pull` also install on demand — if something's missing when you run them, Arbella stops and asks first.

### `arbella init`

The one-time wiring. Pick a host (GitHub, GitLab, or a plain Git URL); if the repo doesn't exist yet, Arbella creates it private for you.

```sh
arbella init
arbella init --provider github --repo you/your-setup --auto-push daily -y
```

Saves your preferences:

- which tools Arbella should manage
- who wins a conflict — your machine or the repo
- auto-push cadence — off, once per session, or daily
- whether secrets are allowed into the repo (off by default), and whether to include memories (also off)

### `arbella push`

The one you'll run most. Captures your current setup, sanitizes it, commits, and pushes. Run it whenever you've changed something worth keeping, or let the auto-push hook do it in the background.

```sh
arbella push
arbella push --dry-run   # show exactly what goes in (and what's skipped), write nothing
```

Worth a `--dry-run` before your first real push, so there are no surprises.

### `arbella pull`

The reason the whole thing exists.

```sh
arbella pull https://github.com/you/your-setup
arbella pull <url> --dry-run
```

- First copies your current `~/.claude` and `~/.codex` to a timestamped safety folder, so a pull can't quietly wreck what's already there.
- Installs any missing CLIs — reaching for `sudo` only when the global npm folder actually needs root.
- Writes files with this machine's paths, then reinstalls your plugins and skills from the manifest.
- Deploys your shared instructions to `CLAUDE.md` and `AGENTS.md`.
- Reminds you to sign back in at the end, since no credentials came along for the ride.

### `arbella status`

Read-only. It answers one question: if you ran `push` right now, what would change?

```sh
arbella status
arbella status --json   # pipe it somewhere
```

New and modified files, plugin drift, the secrets it would skip. Writes nothing, installs nothing.

### `arbella auth`

Handles sign-in to your repo host. You rarely call it yourself — `push` and `pull` sign in on their own when they hit a private repo. It's here for when you'd rather log in ahead of time, or check where you stand.

```sh
arbella auth login
arbella auth status
arbella auth login --provider gitlab
arbella auth login --device-flow   # skip gh/glab, use Arbella's own flow
```

### `arbella secrets`

For the credentials that never belong in the repo. Git is never involved — you carry the blob between your own machines yourself.

```sh
arbella secrets export   # encrypted, passphrase-protected blob (AES-256-GCM)
arbella secrets import   # unpack it on the other machine
```

## How sign-in works

Short version: **gh and glab are preferred, not required.** They're the smoothest route, and the one I'd point you to — but Arbella works without them.

| Situation | What Arbella does |
| --- | --- |
| CLI installed and signed in | Uses it directly. gh/glab already do OAuth properly and configure Git's credentials, so nothing sensitive passes through Arbella. |
| CLI installed, signed out | Runs its `auth login` for you — prints a URL and a code you type into your browser. |
| CLI missing | Offers to install it, or falls back to its own path: an OAuth device flow, or a pasted token kept in a local `0600` file. |

For the device flow, point Arbella at your own registered OAuth app with `ARBELLA_GITHUB_CLIENT_ID` (or `ARBELLA_GITLAB_CLIENT_ID`). There's no sensible default to ship — the client ID is public but tied to your account — so with none set, Arbella skips the device flow and asks for a token instead. SSH and `file://` remotes are left alone, so those keep working however your Git already has them.

## Secrets

This is the part I most wanted to get right.

- Whole credential files (`auth.json`, `.credentials.json`, and the like) sit on a hard denylist and are never read into the repo.
- Everything that *does* get committed runs through a sanitizer that redacts token-shaped values.
- Any token Arbella holds for itself lives in one local file with `0600` permissions — not in the repo, not in a logged command, not baked into a Git remote.
- A test fails the build if a credential can reach the repo. This isn't on the honor system.

Putting secrets in the repo is opt-in, and the default is off. It's your private repo and your call — but I'd leave it there.

## Cross-platform notes

Paths get templated, so a setup captured on a Mac under `/Users/you` restores correctly on Linux under `/home/you`, or on Windows. The one place the machine matters is global npm installs: on a system Node the folder is root-owned, so Arbella elevates with `sudo` and tells you it's doing so; on nvm, Homebrew, or Windows it's already yours, so it skips sudo. It checks first instead of guessing.

## Why "Arbella"

The Arbella was the flagship of the 1630 Winthrop Fleet — a few hundred settlers, their livestock, and the colony's founding charter, carried across the Atlantic to start over somewhere new. That's the idea here: pack up the things that make your environment yours, carry them across, and unpack on the other side.

## Status

v0.1 — early, but it builds clean, the full test suite passes, and I use it daily. Issues and pull requests welcome.

## License

Copyright (c) 2026 Fafoooo.

Arbella is licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only). See [LICENSE](./LICENSE).
