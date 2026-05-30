# ⛵ Arbella — Projektstruktur

> **Name: `arbella`** — benannt nach dem Flaggschiff der Great Migration (1630),
> das Siedler samt ihrer Gründungs-Charter in die neue Welt trug.
>
> Metapher: Nimm dein komplettes KI-Dev-Setup an Bord, segle zu **jedem**
> Rechner (Linux/Mac/Windows), und „besiedle" ihn neu. Ein öffentliches Tool, das
> **jeder** nutzen kann, um Claude Code + Codex (+ Cursor …) **plug & play** zu
> migrieren.

Status: **v0.1 gebaut** — `tsc` grün, 70 Tests grün, CLI lauffähig.

---

## Was Arbella tut (v1: Backup & Migration)

```
BACKUP:   lokales Setup scannen → Secrets raus → Pfade/OS → {{Platzhalter}}
          → handgemachte Dateien + manifest.json → DEIN privates Git-Repo → push
RESTORE:  Ist-Zustand sichern → CLIs installieren → Repo klonen → Dateien einsetzen
          (Platzhalter füllen) → Plugins/Skills nach-installieren → Re-Login-Hinweis
```

## Tech-Stack (recherchiert)

| Wahl | Warum |
|---|---|
| **Node.js + TypeScript** | Cross-OS, riesige Reichweite via npm, passt zu deinem `npx skills`-Workflow |
| **Commander.js** (CLI-Framework) | ~18–25 ms Start vs. ~85–135 ms bei oclif — wichtig, weil **Auto-Backup bei jedem Session-Start** läuft. oclif erst ab 50+ Commands sinnvoll. |
| **Global installiert** | Bare command `arbella …` (kein `npx` davor) |
| **feature-first** statt nach Typ | 2026-Best-Practice; jeder Adapter & jede Engine-Einheit ist isoliert testbar |

---

## Verzeichnisbaum (das TOOL-Repo)

```
arbella/
├── README.md                     # Was/Warum/Quickstart
├── STRUCTURE.md                  # diese Datei
├── package.json                  # (kommt später) name, bin: arbella, deps: commander…
├── tsconfig.json                 # (kommt später)
├── .gitignore                    # node_modules, dist/, + Secret-Schutz
│
├── src/
│   ├── index.ts                  # CLI-Einstieg → verdrahtet Commander
│   ├── commands/                 # ein File pro Command (feature-first)
│   │   ├── init.ts               #   Repo wählen/anlegen (GitHub/GitLab/eigener Git), Tool-Config
│   │   ├── backup.ts             #   scannen → sanitisieren → committen → push
│   │   ├── restore.ts            #   Ist-Backup → CLIs installieren → klonen → einsetzen → reinstall
│   │   ├── status.ts             #   Diff: lokal vs. Repo
│   │   └── secrets.ts            #   secrets export / import (LOKAL, nie über Git)
│   │
│   ├── adapters/                 # ❤️ Pro-Tool-Wissen — hier wird Cursor/Gemini später angedockt
│   │   ├── adapter.interface.ts  #   Vertrag: detect() / capture() / restore() / installCli()
│   │   ├── registry.ts           #   alle Adapter finden & durchlaufen
│   │   ├── claude/               #   ~/.claude: agents/ skills/ hooks/ commands/ CLAUDE.md settings.json
│   │   │   (paths · capture · restore · plugins)
│   │   ├── codex/                #   ~/.codex: agents/*.toml AGENTS.md hooks/ config.toml
│   │   │   (paths · capture · restore · config-toml)
│   │   └── cursor/               #   ~/.cursor + .cursor/rules (Desktop-App: Install via brew/winget)
│   │
│   ├── core/                     # tool-AGNOSTISCHE Engine (von allen Adaptern genutzt)
│   │   ├── sanitizer/            #   Secrets erkennen & entfernen
│   │   │   (denylist: auth.json, .credentials.json, *_API_KEY · patterns: sk-…, bearer)
│   │   ├── templater/            #   Maschinenwerte ⇄ {{HOME}} {{OS}} {{USER}}  (Cross-OS-Herz)
│   │   ├── manifest/             #   manifest.json bauen/lesen (was neu-installiert wird)
│   │   ├── repo/                 #   git-Operationen
│   │   │   └── providers/        #     github · gitlab · generic  (anlegen, falls fehlt)
│   │   ├── secrets/              #   lokaler Tresor: export-Blob / import-Blob (nie über Git)
│   │   ├── autobackup/           #   throttled SessionStart-Hook: aus / jeder-Start / 24h
│   │   └── config/               #   ~/.config/arbella/config.json
│   │       (repo · sourceOfTruth · autobackup · includeSecrets · memories)
│   │
│   ├── platform/                 # OS-Abstraktion: darwin/linux/win32 · CLI-Install (npm/brew/winget)
│   └── utils/                    # fs, logging
│
├── templates/
│   └── backup-repo/              # 📦 BEISPIEL des generierten PRIVATEN Backup-Repos (siehe unten)
│
├── test/
│   ├── fixtures/                 # Fake-$HOME mit Beispiel-.claude/.codex/.cursor
│   ├── unit/                     # Sanitizer, Templater, Manifest, Adapter
│   └── integration/              # capture→restore Round-Trip (Treue-Test)
│
├── docs/
│   ├── superpowers/specs/        # hier landet die Design-Spec
│   └── adr/                      # Architektur-Entscheidungen
│
└── .github/workflows/            # CI: Cross-OS-Matrix (Linux/Mac/Windows)
```

---

## Das generierte BACKUP-Repo (was der Nutzer privat bekommt)

```
my-ai-setup/                  ← DEIN privates Repo (GitHub/GitLab/…)
├── arbella.json             ← Metadaten: Tools, Version, Optionen
├── .gitignore                ← Secrets standardmäßig raus; für Nicht-Geheimes tunebar
├── README.md                 ← auto-generiert: „so spielst du es zurück"
├── claude/
│   ├── files/                ← EINGEFROREN: CLAUDE.md, eigene agents/ skills/ hooks/ …
│   │                            settings.json (sanitisiert + {{HOME}})
│   └── manifest.json         ← Plugins, Marketplaces, skills.sh-Skills, npm-Tools (greppy…)
├── codex/
│   ├── files/                ← AGENTS.md, agents/*.toml, hooks/, config.toml (sanitisiert)
│   └── manifest.json
├── cursor/
│   ├── files/
│   └── manifest.json
└── memories/                 ← OPTIONAL (opt-in)
```

---

## Kern-Entscheidungen (festgehalten aus dem Brainstorm)

1. **Hybrid-Capture:** Handgemachtes wird *eingefroren*; Registry-Kram (Plugins,
   `skills.sh`-Skills, Agent-Kataloge) als *Manifest* neu-installiert.
2. **Secrets = deine Entscheidung:**
   - *Default:* raus (sicher).
   - *Opt-in:* dürfen ins private Repo (deine Verantwortung).
   - *Empfohlen:* `arbella secrets export` → kopieren → `secrets import` auf neuem PC
     — bleibt **lokal**, läuft nie über Git.
3. **Cross-OS via Templater:** absolute Pfade & OS-spezifisches werden zu
   `{{HOME}}`/`{{OS}}` → auf jedem Rechner korrekt befüllt. Keine hardcodierten Pfade.
4. **Adapter-Muster:** je Tool ein Adapter mit gleicher Schnittstelle → Cursor/Gemini
   = neuer Ordner, kein Umbau am Kern.
5. **Source of Truth einstellbar:** `local` (Rechner pusht) oder `repo` (Repo zieht).
6. **Auto-Backup:** throttled SessionStart-Hook — aus / jeder Start / alle 24 h.

## Noch offen / nächste Schritte

- [ ] Design-Spec schreiben (`docs/superpowers/specs/`) und reviewen
- [ ] Dann Implementierungsplan (writing-plans)
- [ ] Danach: `package.json`/`tsconfig.json` + Code-Files füllen
- [ ] Finaler Name + npm-Verfügbarkeit prüfen
