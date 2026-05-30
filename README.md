# ⛵ Arbella

> *Set sail with your complete AI dev setup — back it up, and rebuild it on any machine.*

**Arbella** is an open-source CLI that backs up and migrates your AI coding
environment (Claude Code + Codex, with Cursor & more coming) across
**Linux, macOS, and Windows** — plug & play.

Your **complete setup** — skills, agents, plugins, hooks, settings, memories —
goes into **your own private Git repo**, sanitized and OS-portable, and restores
on a fresh machine with one command.

## Installation

Arbella ships as a single global npm package and provides the bare `arbella`
command on your `PATH`. You need **Node.js ≥ 18** (which bundles `npm`).

```bash
npm install -g arbella          # installs the `arbella` command globally
arbella --help                  # verify the install
```

Prefer a one-liner? The optional install script wraps the same `npm i -g`
(and checks that Node/npm are present first):

```bash
curl -fsSL https://raw.githubusercontent.com/fabioschmickl/arbella/main/install.sh | sh
```

> On a fresh machine with no Node yet, install Node.js from
> [nodejs.org](https://nodejs.org/) first, then run either command above.
> `arbella restore` will auto-install the tool CLIs it needs (Claude Code,
> Codex) via `npm i -g`.

## Usage

```bash
arbella init                    # connect/create your private backup repo
arbella backup                  # snapshot your setup → push to git
arbella restore <repo-url>      # rebuild everything on a new machine
```

- 🔒 **Secrets never leave by accident** — excluded by default; opt-in, or transfer
  them locally with `arbella secrets export` / `import` (never via git).
- 🧩 **Hybrid capture** — hand-made files are frozen; installable things (plugins,
  `skills.sh` skills, agent catalogs) are reinstalled from a manifest.
- 🌍 **Cross-OS** — machine paths are templated, so Windows ⇄ Mac ⇄ Linux just works.
- 🔌 **Extensible** — one adapter per tool (Claude, Codex, Cursor, …).

> ✅ **Status:** v0.1 — TypeScript build green, 70 tests passing, CLI runnable. See [`STRUCTURE.md`](./STRUCTURE.md).

## Setup & Authentication

Arbella is **plug & play**: you should never have to register an OAuth app or
juggle tokens for the common case. Authentication is **`gh`/`glab`-first** with a
zero-config fallback.

### `arbella setup` — install what you need

```bash
arbella setup                   # interactive: pick what to install
arbella setup --all             # install everything supported on this OS
arbella setup --yes             # non-interactive: install the recommended-but-missing set
arbella setup --deps git,gh     # install a specific list
```

`setup` detects which dependencies are present and offers to install the missing
ones, cross-OS — **macOS** via Homebrew, **Windows** via `winget`, **Linux** via
your package manager (`apt`/`dnf`/`pacman`/`zypper`, with `sudo`). It manages:

| Tool | Why |
|------|-----|
| **git** | Required to clone & push your backup repo. *(strongly recommended)* |
| **gh** (GitHub CLI) | Preferred GitHub sign-in — it handles OAuth for you — and private-repo creation. |
| **glab** (GitLab CLI) | Same, for GitLab. |
| **claude / codex / cursor** | The AI tool CLIs Arbella backs up & restores. |

Restore and init also install what they need on demand — if `git` (or `gh`/`glab`)
is missing when you run them, Arbella asks **“not found — install now? [Y/n]”**.

### Signing in (automatic during `init` / `restore`)

You normally don't run a separate login step. When Arbella accesses a **private**
backup repo it authenticates automatically:

1. **Provider CLI first (preferred).** For a GitHub/GitLab repo, if `gh`/`glab` is
   installed and signed in, Arbella just uses it — `gh`/`glab` already configured
   git's credential helper, so the clone/push works and **no token ever passes
   through Arbella**. If the CLI is installed but logged out, Arbella runs
   `gh auth login` / `glab auth login` in your terminal (you complete the normal
   browser / one-time-code flow). If the CLI is *missing*, Arbella offers to
   install it, then sign in.
2. **Fallback (no CLI).** If you decline to install the CLI (or the host isn't
   GitHub/GitLab), Arbella falls back to its own **OAuth Device Flow**
   ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)) or an interactive
   **Personal Access Token** paste (it points you at the right token page). Any
   token Arbella obtains this way is stored **only** in its local data dir, mode
   `0600` — never in the backup repo, manifest, README, git history, or logs.

Manage sign-in explicitly when you want to:

```bash
arbella auth login                    # sign in to GitHub (default)
arbella auth login --provider gitlab  # sign in to GitLab
arbella auth login --device-flow      # skip gh/glab; use Arbella's own flow
arbella auth status                   # show CLI sign-in state + any stored tokens (no secrets)
arbella auth logout                   # clear Arbella's stored tokens
arbella auth logout --provider github # also runs `gh auth logout`
```

### OAuth app registration (only for the fallback)

`gh`/`glab` **handle OAuth themselves — there is nothing to register.** This is the
recommended path and needs no configuration.

The Arbella **device-flow fallback** does need a registered OAuth **App
client_id** (the client id is public, not a secret, but it's account-specific so
Arbella can't ship a working default). Provide it via an environment variable:

```bash
export ARBELLA_GITHUB_CLIENT_ID=<your_github_oauth_app_client_id>
export ARBELLA_GITLAB_CLIENT_ID=<your_gitlab_oauth_app_client_id>
```

When no client_id is configured, the device flow is skipped and Arbella uses the
token-paste fallback instead. SSH and `file://` remotes are never touched by any
of this — they keep working exactly as your git already has them set up.

## Why *Arbella*?

The *Arbella* was the 1630 flagship of the Great Migration — it carried settlers,
their livestock, and the colony's founding **charter** across the Atlantic to a
new world. This tool does the same for your dev environment: it carries your
"charter" — your complete AI setup — to any new machine.

## License

MIT — see [`LICENSE`](./LICENSE).
