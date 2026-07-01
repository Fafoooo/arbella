<!--
Thanks for contributing to Arbella! Keep PRs focused. Title should follow
Conventional Commits (feat:, fix:, docs:, chore:, refactor:, test:, ci:).
-->

## What

<!-- What does this change and why? Link any issue: "Closes #1". -->

## How

<!-- Brief notes on the approach. Call out any new ToolId touch-points wired
     (types, schemas, registry, platform paths/install, denylist, commands) if
     you added or changed an adapter. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run test` passes
- [ ] `npm run build` succeeds
- [ ] New behavior has tests (unit and/or the capture↔restore round-trip)
- [ ] Cross-platform: paths go through `platform/os.ts` (no hardcoded `~`, `/`, or `\`); verified or reasoned for Linux/macOS/Windows
- [ ] **No secret can reach the repo**: credential files stay on the denylist, token-shaped values are sanitized, and no secret is logged or written into a Git remote
- [ ] Docs updated (README / command help) if user-facing behavior changed

## Security impact

<!-- Does this touch capture, the sanitizer, the denylist, auth, or restore
     writes? If yes, explain why secret containment is preserved. If no, say "none". -->
