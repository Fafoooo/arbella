# ⛵ Arbella

Set up your AI coding tools once, then rebuild that setup on any machine.

If you've put real time into Claude Code or Codex (custom skills, a stack of subagents, plugins, hooks, your `CLAUDE.md`), you know how annoying it is to do it all again on a new laptop. Arbella saves that whole setup into a private Git repo you own, and puts it back on another machine with one command. Linux, macOS, Windows.

The everyday command is called `sync`, not `backup`, on purpose. The repo is your source of truth, and you keep it current as your setup changes.

## What it does

Arbella reads the parts of your setup that matter (skills, subagents, plugins, hooks, settings, and your memories if you ask for them), strips out anything secret, swaps machine-specific paths for placeholders, and pushes the result to your private repo.

On a fresh machine, `restore` does the reverse. It installs the CLIs you don't have yet, drops the files back with this machine's paths filled in, reinstalls your plugins and skills, and wires your shared instructions into both Claude and Codex.

Two things it deliberately does not do:

- It never commits secrets. API keys, OAuth tokens, `auth.json`, `.credentials.json`: all excluded, no exceptions. You sign back in after a restore, or move them yourself with `arbella secrets` (below).
- It doesn't copy what it can reinstall. Plugins and registry skills are recorded as a list and pulled fresh on the other side, so the repo stays small and never goes stale.

Supported today: Claude Code and Codex, plus a Cursor adapter that quietly does nothing when Cursor isn't installed.

## Install

Arbella needs Node 18 or newer (that's what gives you `npm`). It isn't on npm yet, so for now you build it from the repo:

```sh
git clone https://github.com/Fafoooo/arbella
cd arbella
npm install && npm run build
npm install -g .          # on a system Node install, put sudo in front
arbella --help
```

Once it's published, this collapses to `npm install -g arbella`.

## The short version

```sh
arbella setup       # install the things arbella leans on (git, gh, the tool CLIs)
arbella init        # point arbella at a private repo and pick your options
arbella sync        # snapshot your setup and push it

# later, on another machine:
arbella restore https://github.com/you/your-setup
```

## The commands, in full

### arbella setup

Checks what's installed and offers to fill the gaps: `git` (required), `gh` and `glab` (the GitHub and GitLab CLIs that handle sign-in for you), and the AI CLIs themselves (claude, codex, cursor). It's a checklist, so you tick what you actually use. Installs go through whatever your system uses: apt, dnf, or pacman on Linux, Homebrew on macOS, winget on Windows. Run it once on a new box and you're set.

You can skip the menu when you already know what you want: `arbella setup --all`, or `arbella setup --deps git,gh -y`.

`init` and `restore` also install on demand. If `git` or a provider CLI is missing when you run them, Arbella stops and asks whether to install it first.

### arbella init

The one-time wiring. It asks which host you want (GitHub, GitLab, or a plain Git URL), and if the repo doesn't exist yet it creates it private for you. Then it saves your preferences:

- which tools arbella should manage
- who wins a conflict, your machine or the repo
- auto-sync cadence: off, once per session, or daily
- whether secrets are allowed into the repo (off by default), and whether to include memories (also off)

Every prompt has a flag too, so you can script it: `arbella init --provider github --repo you/your-setup --auto-backup daily -y`.

### arbella sync

The one you'll run most. (This used to be `backup`, and `arbella backup` still works as an alias so older auto-hooks don't break.) It captures your current setup, sanitizes it, commits, and pushes. Run it whenever you've changed something worth keeping, or let the auto-sync hook do it in the background.

Run `arbella sync --dry-run` first. It shows exactly what would go in and which secrets would be left out, and writes nothing. Worth doing before the first real push so there are no surprises.

### arbella restore

The reason the whole thing exists. Point it at your repo:

```sh
arbella restore https://github.com/you/your-setup
```

Before it touches anything, it copies your current `~/.claude` and `~/.codex` to a timestamped safety folder, so a restore can't quietly wreck what's already there. Then it installs any missing CLIs (reaching for `sudo` only when the global npm folder actually needs root, which it does on most plain Linux boxes), writes the files with this machine's paths, reinstalls your plugins and skills from the manifest, and deploys your shared instructions to `CLAUDE.md` and `AGENTS.md`. At the end it reminds you to sign back in, since no credentials came along for the ride.

`--dry-run` works here too.

### arbella status

Read-only. It answers one question: if you ran `sync` right now, what would change? New and modified files, plugin drift, the secrets it would skip. It writes nothing and installs nothing. Add `--json` to pipe it somewhere.

### arbella auth

Handles sign-in to your repo host: `login`, `status`, `logout`. `arbella auth login --provider gitlab` targets GitLab; `--device-flow` skips `gh`/`glab` and uses Arbella's own flow. You rarely call this yourself, since `sync` and `restore` sign in on their own when they hit a private repo. It's here for when you'd rather log in ahead of time, or just check where you stand.

### arbella secrets

For the credentials that never belong in the repo. `arbella secrets export` bundles your local secret files into an encrypted blob (passphrase-protected, AES-256-GCM) that you copy across yourself. `arbella secrets import` unpacks it on the other machine. Git is never involved. Use it when you'd rather carry your tokens between your own machines than re-authenticate everywhere.

## How sign-in works

Short version: Arbella prefers `gh` and `glab`, and falls back to its own flow if they aren't there. So, to answer the obvious question: no, the provider CLIs aren't strictly required. They're just the smoothest route, and the one I'd point you to.

If the GitHub or GitLab CLI is installed and signed in, Arbella just uses it. Those tools already do OAuth properly and configure Git's credentials, so nothing sensitive passes through Arbella. If the CLI is there but you're signed out, Arbella runs its `auth login` for you, the one that prints a URL and a code you type into your browser. If the CLI is missing, it offers to install it.

Only when you turn all of that down does Arbella use its own path: an OAuth device flow, or a pasted personal access token kept in a local file. If you want the device flow, point Arbella at your own registered OAuth app with `ARBELLA_GITHUB_CLIENT_ID` (or `ARBELLA_GITLAB_CLIENT_ID`). The client ID is public, but it's tied to your account, so there's no sensible default to ship; with none set, Arbella skips the device flow and asks for a token instead. SSH and `file://` remotes are left alone, so those keep working however your Git already has them.

## About secrets

This is the part I most wanted to get right.

Whole credential files (`auth.json`, `.credentials.json`, and the like) sit on a hard denylist and are never read into the repo. Everything that does get committed runs through a sanitizer that redacts token-shaped values in your settings and config. Any token Arbella holds for itself lives in one local file with `0600` permissions: not in the repo, not in a logged command, not baked into a Git remote. A test fails the build if a credential can reach the backup, so this isn't on the honor system.

Putting secrets in the repo is opt-in. Turn it on if you want, it's your private repo and your call, but the default is off and I'd leave it there.

## Cross-platform notes

Paths get templated, so a setup captured on a Mac under `/Users/you` restores correctly on Linux under `/home/you`, or on Windows. The one place the machine matters is installing global npm packages. On a system Node install that folder is owned by root, so Arbella elevates with `sudo` and tells you it's doing so. On nvm, Homebrew, or Windows the folder is already yours, so it skips sudo entirely. It checks first instead of guessing.

## Why "Arbella"

The Arbella was the flagship of the 1630 Winthrop Fleet. It carried a few hundred settlers, their livestock, and the colony's founding charter across the Atlantic to start over somewhere new. That's the idea here: pack up the things that make your environment yours, carry them across, and unpack on the other side.

## Status

v0.1. Builds clean, full test suite green, used daily by at least one stubborn person. Issues and pull requests welcome.

## License

MIT. See [LICENSE](./LICENSE).
