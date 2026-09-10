# AGENTS.md — Guide for AI agents working on Dogwalker

You are working on **Dogwalker**: a free, cross-platform (macOS/Windows/Linux) Electron app that puts real terminals on an infinite canvas so AI coding agents can be orchestrated visually and talk to each other through a structured CLI protocol.

## Project status

v1.5.2 is released; v1.5.3 is in development.

## Invariants — do not violate without explicit human sign-off

These were deliberate decisions with reasoning behind them (see ARCHITECTURE.md for full context):

1. **Terminals are never static screenshots at working zoom levels.** The rendering degradation ladder (WebGL → throttled DOM renderer → suspended-offscreen) is the mechanism; per-terminal **renderer hot-swap at runtime** is a required capability of the terminal node component. ([§4](docs/ARCHITECTURE.md#4-terminal-rendering-the-degradation-ladder))
2. **`ask` captures the target's output; it needs no cooperation from the target.** The broker injects the message, waits for the target to go quiet (the focus-independent quiescence detector, §6), and returns the plain-text output it produced. There is no `reply` command — requiring the target to run one was fragile (plain shells and uncooperative agents never replied; `--stdin` deadlocked) so it was removed. This reverses the earlier "screen is not transport" rule after real-world testing; capturing is robust and works with any agent, shell, or process. ([§5.2](docs/ARCHITECTURE.md#52-ask--structured-messaging-via-captured-output))
3. **PTY injection is one atomic write**: bracketed-paste open + body + close + CR in a single `write()`. Never split it, never sleep between paste and Enter (splitting causes a visible flash in the target TUI). Wrap in bracketed paste only if the target has DEC mode 2004 active (tracked by the headless mirror). ([§5.2](docs/ARCHITECTURE.md#52-ask--structured-messaging-via-captured-output))
4. **No logic in the CLI shim.** Authorization, routing, and state live in the host broker; the shim parses argv, sends one JSON request with `DOGWALKER_TERMINAL_ID`, streams the response. ([§5.1](docs/ARCHITECTURE.md#51-transport))
5. **Authorization = the connection graph.** A terminal's CLI requests can only reach nodes it is wired to; Walker verbs additionally require the Walker flag. No ambient authority. ([§11](docs/ARCHITECTURE.md#11-security-posture))
6. **Agents are vendor-agnostic launch configs.** Dogwalker talks to agents only via PTY writes and the CLI protocol. Never add per-vendor code paths, API calls to model providers, or TUI-specific parsing. Images go to agents as temp-file paths in the prompt — the single uniform mechanism.
7. **Floors are git worktrees.** No filesystem-specific tricks (no APFS/CoW dependencies). Worktree constraints (one checkout per branch; untracked files need setup hooks) are surfaced to the user, not worked around.
8. **Attention detection uses OSC 133** (fallback: output quiescence), running on the headless mirror. UI focus suppresses the *notification only*, never the detection.
9. **Everything local, zero telemetry, open file formats** (markdown notes, JSON layouts, JSONL message history). The product is 100% free: no license checks, no tiers, no payment code.
10. **Out of scope — do not add:** command palette / full-text search, built-in local LLM assistant, remote execution environments (SSH/Docker provisioning), MCP server, i18n. Rationale in [PRODUCT.md §1 non-goals](docs/PRODUCT.md#non-goals-explicitly-out-of-scope) and [§5.3](docs/PRODUCT.md#53-the-cli-is-the-entire-api).

## Conventions

- **Language:** TypeScript throughout; strict mode.
- **Naming:** the product/CLI/env-var prefix is `dogwalker` / `DOGWALKER_*`. Dogwalker is a clean-room product: never reference other products in this category — their names, branding, or documentation text — in code, UI, or docs.
- **Process placement:** capability → main-process broker; presentation → renderer. If a feature is reachable by both the UI and the CLI, there is exactly one implementation (in the broker) and two thin callers.
- **Docs stay truthful:** when behavior lands or changes, update `docs\*.md` (just where necessary) in the same change.
- **Tests are colocated and behavior-focused:** unit/component tests are Vitest, next to the file under test as `<name>.test.ts[x]` (node for `src/main`/`src/shared`, jsdom + Testing Library for `src/app`); app-level end-to-end tests are Playwright under `e2e/`. Test what a unit does, not how it does it — no separate ad-hoc test files.

## Releasing a version

Dogwalker ships version-by-version ([ROADMAP.md](docs/ROADMAP.md)). Cut a release
from `main`, once the version's work has landed and `npm run typecheck`,
`npm run lint`, and the `DW_*TEST` harnesses the change touched are all green.
Every file that must move, end to end:

1. **`package.json`** — set `"version"` to the new `X.Y.Z` (SemVer: patch = fixes,
   minor = features, major = breaking). It lags behind development and is bumped
   here, at release time.
2. **[AGENTS.md](AGENTS.md) → Project status** — update the line above (mark the
   version released, or bump it to the next `vX.Y.Z is in development`).
3. **[docs/CHANGELOG.md](docs/CHANGELOG.md)** — the newest section *is* the
   release: retitle its top `## X.Y.Z — Unreleased` to `## X.Y.Z`, newest-first,
   listing the user-facing changes. Add the section if it doesn't exist yet.
4. **[docs/ROADMAP.md](docs/ROADMAP.md)** — add the version's row to the table and
   its section (Expectation / Outputs / Exit criteria) in the standardized format.
5. **[skills/dogwalker/SKILL.md](skills/dogwalker/SKILL.md)** — if the CLI/agent
   contract changed, bump the `version:` in its frontmatter so installed skills
   are flagged to re-read (`installSkill` warns on a version mismatch).
6. **README** — the install table uses a `<version>` placeholder and links to
   `/releases/latest`, so it needs no per-release edit; touch it only if the
   public surface actually changed.
7. **Distribution** — no per-release step. The `publish-packaging` CI job bumps the
   Homebrew, Scoop and AUR channels automatically after the tag build, once their
   secrets are configured (see [packaging/README.md](packaging/README.md)); it's a
   no-op otherwise. Auto-update (`update.electronjs.org`) needs nothing either.
8. **Commit** the bump (convention: `chore: set vX.Y.Z package version`) and get
   it onto `main` (via PR — the `check` job gates every PR to `main`).

**Trigger the release build.** Packaging is driven entirely by a `v*` **git tag**
(`.github/workflows/build.yml`). Tag the release commit on `main` and push the tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

That fires the workflow's `make` matrix (macOS / Windows / Linux; tag-only), which
runs `npm run make` on each runner and attaches every OS's installer to the tag's
GitHub Release via `action-gh-release`. The `check` job (typecheck + lint) gates
PRs to `main`; packaging never runs on a PR, only on the tag. Installers are
unsigned (documented first-launch Gatekeeper/SmartScreen warnings).

To redo a botched release, delete the tag both places
(`git tag -d vX.Y.Z && git push origin :vX.Y.Z`), fix, then re-tag and push.
