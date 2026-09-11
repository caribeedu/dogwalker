# Dogwalker — Roadmap

The path from empty repo to public release, one version at a time. Each version has an **expectation** (what it proves or unlocks), **outputs** (the concrete deliverables), and **exit criteria** (measured, not felt). Scope references [PRODUCT.md](PRODUCT.md) and [ARCHITECTURE.md](ARCHITECTURE.md) instead of restating them; **anything not listed for a version is deferred by default**. The non-goals in [PRODUCT.md §1](PRODUCT.md#non-goals-explicitly-out-of-scope) are out of scope at every version.

| Version | Theme | One-line gate |
|---|---|---|
| [v0.0.1](#v001--alpha-the-spike) | Alpha: stack validation | Perf numbers hit, or the stack decision reopens |
| [v0.1](#v01--the-core-loop) | The core loop (canvas + terminals + messaging + notes) | Dogfooding starts: Dogwalker is developed inside Dogwalker |
| [v0.2](#v02--daily-driver-comfort) | Daily-driver comfort (canvas & shell completion) | A full workday inside Dogwalker with no reason to leave |
| [v0.3](#v03--file-tree--visual-context) | File Tree & visual context | Code browsing/editing/git without leaving the canvas |
| [v0.4](#v04--portals) | Portals (embedded automatable browsers) | An agent completes a browser task end-to-end |
| [v0.5](#v05--floors) | Floors (parallel worktrees) | A real feature developed and landed entirely on a floor |
| [v0.6](#v06--automation-routines--walker-mode) | Automation: Routines & Walker mode | A Walker assembles a team; routines run for a week unattended |
| [v0.7](#v07--hardening-beta) | Hardening (beta, feature freeze) | Stable at 2× target scale on all three OSes |
| [v0.8](#v08--release-engineering) | Release engineering (RC) | A stranger can install from an artifact, not from source |
| [v1.0](#v10--launch) | Launch | PRODUCT.md is true, installers public, release tagged |
| [v1.1.0](#v110--roles-presets--brand-polish) | Roles, Presets & brand polish | An agent can be launched or reassigned from reusable, persisted team configuration |
| [v1.2.0](#v120--team-operations--contracts) | Team Operations & contracts | An authorized team loop returns concise, contract-validated output |
| [v1.2.1](#v121--contract-result-ergonomics--documentation-consolidation) | Contract result ergonomics & documentation consolidation | Contract results are loop-ready and public docs are coherent |
| [v1.3.0](#v130--iconography--json-schema-contracts) | Iconography & JSON-Schema contracts | Chrome is all SVG; a contract loops until the answer matches its JSON Schema |
| [v1.3.1](#v131--ci-node-bump) | CI Node bump | The release build runs on Node 24 and installs cleanly |
| [v1.3.2](#v132--spawn-time-role-ordering) | Spawn-time role ordering | A terminal's preset agent starts before its role is injected |
| [v1.3.3](#v133--composer-portal--leash-fixes) | Composer, portal & leash fixes | Composer clears on send, portals respect layering, connections are removable |
| [v1.4.0](#v140--app-themes-open-composer--schema-tree) | App themes, open composer & schema tree | The UI is themeable, the composer @mentions terminal recipients, and schemas edit as a tree |
| [v1.4.1](#v141--theme-tokenization--composer-polish) | Theme tokenization & composer polish | App themes recolor the whole chrome; composer tints @mentions inline |
| [v1.5.0](#v150--universal---json--codemirror-schema-editor) | Universal --json & CodeMirror schema editor | Every CLI verb speaks `--json`; contracts edit their schema in a linted CodeMirror |
| [v1.5.1](#v151--design-system-polish) | Design-system polish | Themed scrollbars/checkboxes, dev palette placement, README badges |
| [v1.5.2](#v152--distribution-automation) | Distribution automation | The tag CD auto-bumps the Homebrew, Scoop and AUR channels |
| [v1.5.3](#v153--packaged-ui-load--gatekeeper-docs) | Packaged UI load & Gatekeeper docs | Packaged app paints its UI; macOS "damaged" quarantine is documented |
| [v1.5.4](#v154--pty-spawn-helper--renderer-protocol) | PTY spawn-helper, renderer protocol & macOS name | Local/packaged PTY spawn works; packaged UI loads; macOS shows Dogwalker |
| [v1.5.5](#v155--asar-safe-shim-copy) | Asar-safe shim copy | Packaged app reaches loadURL (no hang in createShimDir) |

---

## v0.0.1 — Alpha: the spike

**Expectation:** falsify the architecture as cheaply as possible. Every risky bet — React Flow hosting live terminals, the renderer degradation ladder, the headless mirror — is exercised before any product feature exists. Code from this phase is allowed to be throwaway; the *conclusions* are the deliverable.

**Outputs**
1. Electron + TypeScript (strict) scaffold with the main/renderer split of [ARCHITECTURE.md §2](ARCHITECTURE.md#2-process-model); one hardcoded workspace, no persistence.
2. React Flow canvas with a custom terminal shape (pan/zoom, move/resize only).
3. Terminal pipeline: node-pty in main ↔ xterm.js in renderer over a dedicated byte channel; agent presets as auto-executed commands; `DOGWALKER_*` spawn env already injected ([ARCHITECTURE.md §3](ARCHITECTURE.md#3-terminal-subsystem)).
4. Headless mirror (xterm-headless per PTY) proving screen serialization works while the renderer instance is suspended.
5. Degradation ladder tiers 1–3 with **per-terminal renderer hot-swap at runtime** and the WebGL context budget ([ARCHITECTURE.md §4](ARCHITECTURE.md#4-terminal-rendering-the-degradation-ladder)). Tier 4 is intentionally not built.
6. Perf HUD: fps, per-tier terminal counts, live WebGL contexts, main/renderer CPU & RAM.
7. A short findings note appended to ARCHITECTURE.md (what held, what surprised, what was tuned).

**Exit criteria**
- 15 terminals running **real agents** (Claude Code + at least one other preset) producing output concurrently.
- Sustained ≥ 55 fps while panning/zooming; typing echo in the focused terminal < ~50 ms.
- Tier transitions cause no lost scrollback, no reflow glitches, no terminal restarts.
- ≤ 8 WebGL contexts ever live; zero context-loss events in a 30-minute session.
- Dogwalker's own processes ≤ ~500 MB with 15 quiet terminals (agents excluded).
- Verified on Windows (macOS and Linux deliberately deferred to the v0.7 cross-OS QA matrix).

**Failure protocol:** if the criteria can't be met after honest optimization, findings go into ARCHITECTURE.md and the stack decision reopens *before* v0.1. That is the spike doing its job.

---

## v0.1 — The core loop

**Expectation:** the differentiating loop — *watch agents on a canvas, wire them, they talk* — works end to end and is reliable enough that Dogwalker development moves inside Dogwalker permanently. This is the largest single version; everything after it is incremental.

**Outputs**
1. **Workspaces**: create/edit/switch, working directory + icon, full sidebar, JSON persistence, load-only-active on startup ([PRODUCT.md §12](PRODUCT.md#12-workspaces--shell), [ARCHITECTURE.md §10](ARCHITECTURE.md#10-persistence--hibernation)).
2. **Canvas, working set**: node create/move/resize/duplicate/delete, grid snapping, focus/zoom-to-selection, keyboard navigation, undo/redo ([PRODUCT.md §3.1–3.2](PRODUCT.md#31-node-creation--manipulation)).
3. **Terminals & agents**: the five shipped presets + custom ([PRODUCT.md §4.2](PRODUCT.md#42-agents--launch-configs)), names/icons, number badges, one dark + one light theme. Attention system with OSC 133, dot + cycle shortcut + system notifications ([PRODUCT.md §4.4](PRODUCT.md#44-attention-system), [ARCHITECTURE.md §6](ARCHITECTURE.md#6-attention-detection)).
4. **Broker + CLI + skill**: all of [ARCHITECTURE.md §5](ARCHITECTURE.md#5-the-ipc-bus--dogwalker-cli) for `ask` / `check` / `list` / `connect` / `disconnect`; atomic bracketed-paste injection; timeouts; JSONL message history; the skill teaching agents the contract; roles as instruction files ([PRODUCT.md §4.3](PRODUCT.md#43-roles)).
5. **Connections**: leash + circuit visuals, tool/shortcut creation, connections popover, per-leash message history view ([PRODUCT.md §5](PRODUCT.md#5-connections--the-dogwalker-cli)).
6. **Notes**: markdown on disk, raw/formatted modes, rename, drag-in external files, delete-with-file, note chaining, `note read|append|write` verbs ([PRODUCT.md §6](PRODUCT.md#6-notes)); image paste landed in v0.3.
7. **Prompt Composer**: floating editor, per-terminal persistent drafts, send/newline/passthrough keys, image paste via temp-file path, @-mentions of connected terminals and notes ([PRODUCT.md §7](PRODUCT.md#7-prompt-composer)).
8. `npm start` works on the three OSes.

**Exit criteria**
- Dogfooding is real: multiple wired agents, daily, in a Dogwalker workspace.
- The README quick start works exactly as written.
- An unattended `ask`→work→captured-output round-trip completes while the user clicks around, focuses the target terminal, and types elsewhere.
- Any leash's history view reconstructs a full conversation accurately.
- A 10+ node workspace restores byte-identical layout after restart; drafts survive restart.
- Attention fires correctly for all five presets; no false positives mid-interaction.

---

## v0.2 — Daily-driver comfort

**Expectation:** dogfooding (started in v0.1) exposes friction; this version removes it. Nothing conceptually new — the canvas and workspace shell reach their full PRODUCT.md shape, so living in Dogwalker all day feels good rather than merely possible.

**Outputs**
1. **Canvas completion**: groups (create/ungroup/rename/move-by-header), align/distribute, tidy, magnetic snapping, minimap, tool auto-revert ([PRODUCT.md §3.3](PRODUCT.md#33-organization)).
2. **Workspace shell completion**: folders and group dividers in the sidebar, mini sidebar, per-workspace number shortcuts, prev/next switching, hibernation (manual + load-only-active), open-in-editor button ([PRODUCT.md §12](PRODUCT.md#12-workspaces--shell)).
3. **Terminal completion**: theme gallery + user-supplied custom themes + follow-system toggle, per-terminal memory limits ([PRODUCT.md §4.1](PRODUCT.md#41-terminals)).
4. First-run experience: sensible empty state, a seeded example workspace.

**Exit criteria**
- A full workday inside Dogwalker with zero "I had to leave for X" notes.
- Hibernate/resume cycle on a 15-node workspace loses nothing and resumes in seconds.
- A custom theme file loads and renders correctly; memory limit demonstrably kills a runaway process while the shell survives.
- Groups survive copy/paste and undo/redo (the PRODUCT.md contract).

---

## v0.3 — File Tree & visual context

**Expectation:** code stops requiring an external editor for everyday browsing, quick edits, and git operations; agents gain richer visual context. This is the last "single-player" feature block — everything after touches agent capabilities.

**Outputs**
1. **File Tree node**, multiple independent instances: list view, icon grid with previews, git diff view, git graph view ([PRODUCT.md §8](PRODUCT.md#8-file-tree)).
2. File ops (create/rename/move/delete), drag-to-terminal (paths to agents), drag-to-canvas (preview nodes).
3. Git branch menu: commit, pull/push, checkout, branch, merge, fetch, stash — via system `git` ([ARCHITECTURE.md §1](ARCHITECTURE.md#1-stack--rationale)).
4. **Embedded CodeMirror 6 editor**: syntax highlighting, find & replace, multi-cursor, send-selection-to-agent.
5. Fuzzy file-name search per node + `>`-prefixed content search with jump-to-line.
6. **Notes image paste** (deferred from v0.1): stored alongside the note, rendered in formatted view, readable by connected agents ([PRODUCT.md §6](PRODUCT.md#6-notes)).

**Exit criteria**
- A day's git workflow (branch, commit, push, diff review) completed entirely in Dogwalker on a real repo.
- Diff and graph views correct on a repository with 1,000+ commits and multiple branches.
- Editor round-trip: open file → multi-cursor edit → save → agent sees the change; send-to-agent injects the selection with file/line reference.
- An agent describes an image pasted into a connected note (proves the read path).

---

## v0.4 — Portals

**Expectation:** agents gain eyes and hands on the web without any external browser-automation dependency. The broker's verb surface grows for the first time since v0.1, proving the "CLI is the entire API" design scales ([PRODUCT.md §5.3](PRODUCT.md#53-the-cli-is-the-entire-api)).

**Outputs**
1. **Portal node**: isolated `WebContentsView` per portal with its own session partition; URL bar, back/forward, reload ([ARCHITECTURE.md §9](ARCHITECTURE.md#9-portals)).
2. Linked portals sharing a session partition (multi-account testing) ([PRODUCT.md §9](PRODUCT.md#9-portals)).
3. **`portal` CLI verbs** over CDP: navigate, click, type, scroll, screenshot (returned as temp-file path), js, dom, console — broker-gated by the connection graph.
4. Agent-created portals (`@New Portal` in the composer + CLI creation).
5. Skill updated to teach the portal contract.

**Exit criteria**
- An agent completes an end-to-end browser task unattended: navigate → interact with a form → screenshot → reason about the screenshot — via CLI only.
- Two linked portals hold two simultaneous logged-in sessions of the same site; two *unlinked* portals hold different accounts without leakage.
- Portal automation works while the portal is offscreen (canvas scrolled away).
- CDP session survives page navigations and reloads without re-attachment bugs.

---

## v0.5 — Floors

**Expectation:** parallel work stops requiring stash/branch juggling. The git-worktree design ([ARCHITECTURE.md §8](ARCHITECTURE.md#8-floors-git-worktrees)) proves itself cross-platform — the feature the macOS-only incumbent ties to APFS, Dogwalker does everywhere.

**Outputs**
1. Floor create/rename/delete over `git worktree add/remove`; branch pick-or-create; per-floor canvas layer (clone ground or start empty) and terminals rooted in the worktree ([PRODUCT.md §10](PRODUCT.md#10-floors)).
2. **Land flow**: clean-tree check → target branch selection → merge → worktree removal → branch-delete checkbox; diff stats and conflict surfacing (resolution stays in the user's tools).
3. **Hooks**: setup (with auto-run), run, teardown; `DOGWALKER_FLOOR_NAME` / `BRANCH_NAME` / `FLOOR_PATH` / `ROOT_PATH` / `PROJECT_NAME` env.
4. Worktree constraints surfaced in UI (one checkout per branch; untracked files need setup hooks — the documented trade-offs).
5. Broker/CLI aware of floors (`list` shows floor context; `ask` reaches cross-floor targets when wired).

**Exit criteria**
- A real feature: floor created → setup hook installs deps → agents work on it → committed → landed → teardown — while the ground floor runs its own dev server, no collisions.
- Two floors run two dev servers on different ports simultaneously.
- Land with a deliberate conflict surfaces it clearly and aborts safely (no half-merged state).
- Full lifecycle verified on Windows, macOS, and Linux.

---

## v0.6 — Automation: Routines & Walker mode

**Expectation:** Dogwalker graduates from a place where you drive agents to a place where agent work drives itself. Both features are thin layers over machinery that already exists — routines reuse the attention lifecycle signals, Walker mode reuses broker verbs — which is the payoff of the v0.1 architecture.

**Outputs**
1. **Routines**: prompt + interval + target agent; `&&`-chained steps waiting on turn completion; pause/resume/edit/delete; live status indicator ([PRODUCT.md §11](PRODUCT.md#11-routines)).
2. **Walker mode**: the Walker flag on terminal creation; `recruit --agent --role [--floor]` / `dismiss` / `assign` broker verbs; recruits auto-position near their Walker; `@Walker` in the composer ([PRODUCT.md §5.4](PRODUCT.md#54-walker-mode-manager-agents)).
3. Skill updated: Walker instructions (team assembly, wiring recruits to notes, dismissal etiquette).

**Exit criteria**
- A natural-language instruction to a Walker ("assemble a coder + reviewer + tester team sharing the SPEC note") produces the wired team without manual canvas work.
- A routine chain (build && test && summarize-to-note) runs on schedule for a week of dogfooding without zombie states.
- Dismissing a recruit cleans up its node, connections, and history references correctly.
- A recruited agent on another floor completes an `ask` round-trip with its Walker.

---

## v0.7 — Hardening (beta, feature freeze)

**Expectation:** no new features — the version where Dogwalker becomes trustworthy. Scale margins, failure recovery, and cross-OS consistency get systematic attention; the docs get a truth pass so PRODUCT.md and reality converge before packaging.

**Outputs**
1. **Scale pass**: profiling at 30+ terminals / 3 workspaces; tier-4 snapshot rendering built *only if* this profiling demands it ([ARCHITECTURE.md §4](ARCHITECTURE.md#4-terminal-rendering-the-degradation-ladder)).
2. **Failure recovery**: crashed agent process, killed PTY, broker restart, stale msg-ids, orphaned worktrees, portal renderer crash — each detected and recovered or cleanly surfaced.
3. **Cross-OS QA matrix**: full feature checklist executed on Windows, macOS, Linux (X11 + Wayland); ConPTY quirks addressed.
4. `CLAUDE.md`/`AGENTS.md` sync toggle ([PRODUCT.md §12](PRODUCT.md#12-workspaces--shell)) — last deferred feature, lands before the freeze.
5. **Docs truth pass**: every PRODUCT.md statement verified against the build or consciously amended; ARCHITECTURE.md updated with as-built reality.
6. Bug backlog triaged to zero known data-loss or corruption issues.

**Exit criteria**
- One week of daily use at 2× normal scale with zero crashes and zero data loss.
- Kill -9 on the app mid-session: restart restores every workspace, note, draft, and history intact.
- The cross-OS matrix passes 100% (or failures are documented as known limitations in README).
- All ten [AGENTS.md invariants](../AGENTS.md#invariants--do-not-violate-without-explicit-human-sign-off) audited against the code and holding.

---

## v0.8 — Release engineering (RC)

**Expectation:** Dogwalker becomes installable by someone who has never seen the repo. Everything here is distribution mechanics; the app itself only changes for RC-blocking bugs.

**Outputs**
1. Packaged installers: dmg (macOS), exe/msi (Windows), AppImage (Linux); reproducible build scripts.
2. Code signing + macOS notarization where feasible (documented gaps where not).
3. MIT `LICENSE` file; README flipped from "intended flow" to actual install instructions.
4. Public GitHub repo under the author's personal account; issue templates; CONTRIBUTING notes; CI building all three artifacts per tag.
5. Versioned skill: the installed skill carries a version and the broker warns on mismatch.
6. RC builds (v0.8.x) cut from CI and installed fresh on clean machines/VMs.

**Exit criteria**
- Fresh-machine test on each OS: download artifact → install → two-agent `ask` working in under 10 minutes using only the README.
- No OS security theater beyond the expected (documented Gatekeeper/SmartScreen behavior for unsigned pieces, if any).
- CI produces all three artifacts from a clean tag with no manual steps.

---

## v1.0 — Launch

**Expectation:** the public release. By this point the work is verification and announcement, not construction.

**Outputs**
1. Final parity audit: PRODUCT.md is true of the shipped build — zero silent gaps.
2. v1.0.0 tag + GitHub Release with the three artifacts and release notes (written from this roadmap's trail).
3. README screenshots/GIF of a real multi-agent session (the dogfooding workspace).
4. Launch post/announcement wherever the author chooses.

**Exit criteria**
- A stranger on each OS reaches a working wired-agents session from the release page alone.
- Issues are open, labeled, and the contribution path in README is honest.
- The author ships the next Dogwalker feature *using* Dogwalker v1.0.

---

## v1.1.0 — Roles, Presets & brand polish

The first post-launch feature release completes the
configuration layer that the v1.0 canvas already exposes: reusable agent launch
presets and reusable role instructions. It does not add a provider integration:
agents remain vendor-agnostic commands driven only through the PTY and the
Dogwalker CLI.

**Expectation:** setting up a repeatable team becomes configuration rather than
retyping commands and instructions per terminal. A user can define a role once,
pair it with a preset when recruiting, and see exactly who each terminal is
meant to be.

**Outputs**
1. **Preset library:** ship the existing built-in shell/agent presets as
   read-only defaults; add persisted custom presets with display name, icon and
   command. The Presets panel supports create, edit, duplicate and delete for
   custom entries, validates required fields, and never hardcodes behavior for
   a particular agent vendor.
2. **Role library:** persisted, reusable roles with a name and Markdown
   instruction body. The Roles panel supports create, edit, duplicate, delete
   and a readable empty state. Role files are stored locally in an open format,
   as with notes and layouts.
3. **Terminal assignment:** creation and duplicate flows can select a preset and
   a role. The terminal header/context controls show the current role and allow
   reassignment without respawning the PTY or dropping its graph connections.
4. **Agent context delivery:** assigning a role materializes its instruction
   file in the terminal's working context and gives the running agent a stable,
   vendor-neutral reference to it. Reassignment refreshes that reference; it
   must not depend on parsing a vendor TUI or calling a provider API.
5. **Walker integration:** recruit with an agent preset and role resolves names
   from the same preset/role libraries as the UI. Invalid or deleted
   configuration returns a clear broker error; recruits preserve their chosen
   role in the persisted layout and across floor boundaries.
6. **Persistence and migration:** terminal specs persist preset and role ids
   rather than display labels. Existing workspaces migrate safely to built-in
   presets with no role, and a missing custom preset/role remains visible as a
   recoverable configuration warning instead of preventing a workspace from
   opening.
7. **Brand polish:** move the public logo and README banner into assets,
   refresh the README reference, and refine both SVGs. The hero mirrors the
   final logo and presents the terminal, note and connection vocabulary with
   consistent, scale-independent vector artwork.
8. **Validation:** add focused in-app harness coverage for preset/role CRUD,
   persistence/migration, terminal reassignment, role-context delivery and
   Walker recruitment; retain typecheck and lint as release gates. Update
   PRODUCT.md, ARCHITECTURE.md and README.md whenever the shipped role delivery
   or preset surface differs from the current documentation.

**Exit criteria**
- A custom preset and a custom role survive app restart and are selectable when
  creating a terminal.
- A role assigned to a live terminal changes its available instruction context
  without terminating the process or changing any leashes.
- A Walker recruits a terminal by named custom preset and role on both ground
  and a floor; the CLI list and the canvas show the expected labels.
- Deleting a role or preset that is still referenced never corrupts a workspace
  and leaves the user a direct repair path.
- The README banner and logo render crisply at their documented sizes in the
  repository, release page and packaged-app surfaces.

---

## v1.2.0 — Team Operations & contracts

This version makes the existing connection graph useful
for deliberate multi-agent loops: fan a task out to authorized teammates, get
machine-readable outcomes back, and let a Walker choose the next action without
repeating or screen-scraping noisy transcripts. It remains entirely local and
vendor-neutral: Dogwalker only injects PTY text and validates captured output.

**Expectation:** a team lead can ask several reviewers for the same decision,
receive compact validated results, and continue the loop using the existing
CLI, roles, floors and message history.

**Outputs**
1. **Targeted team asks:** `dogwalker ask --all`, explicit comma-separated
   terminal targets, and exclusions for directly connected terminals. Each
   recipient is independently authorized; partial timeout/failure returns the
   successful peers instead of failing the whole round.
2. **Stable automation envelopes:** `--json` on `ask`, with documented `ok`,
   `data` and `error` fields. Broadcast output is deterministic
   and contains a result per target (name, stable id, status, output/error).
3. **Contract library:** persisted local named contracts containing a
   description and a constrained object schema (required fields and scalar/array
   types). The Panel creates, adjusts required fields, duplicates and deletes
   entries with a readable
   empty state; deleted contracts fail clearly but never corrupt history.
4. **Broker validation:** `ask --contract <name>` injects exact output guidance,
   extracts one JSON value from the captured response, validates it in the host,
   and exposes `valid`, parsed value and validation errors. `--strict` gives a
   non-zero result for an invalid answer; raw output remains inspectable.
5. **History and Walker loop:** a broadcast id groups its per-leash history
   entries in the UI. Walkers can broadcast review/research requests on ground
   or floors and consume contract results in a follow-up command.
6. **Validation and truth pass:** focused harnesses cover graph authorization,
   partial failure, output ordering, JSON envelopes, contract CRUD/persistence,
   JSON extraction/validation and cross-floor Walker broadcasts. PRODUCT.md,
   ARCHITECTURE.md and README.md describe the shipped behavior exactly.

**Exit criteria**
- A terminal can broadcast only to its directly connected peers; an unconnected
  target is denied even when another target in the same round succeeds.
- A timed-out or malformed response leaves the valid results of other peers
  available in a deterministic JSON envelope.
- A custom contract survives restart, validates a live agent answer,
  and returns actionable errors for a malformed answer without hiding raw
  history.
- A Walker can consume a contract-backed broadcast result without parsing
  terminal decorations.
- No vendor-specific adapter, provider call, ambient authority, silent retry or
  renderer snapshot is introduced.

---

## v1.2.1 — Contract result ergonomics & documentation consolidation

A patch release that makes single contract
results ready for the next orchestration step and consolidates Dogwalker's public
documentation under `docs/`.

**Outputs**
1. Public reference documents live in `docs/`; the repository `README.md`
   remains the GitHub landing page and `AGENTS.md` remains the contributor guide.
2. Internal links, release links and version references point to their current
   locations and v1.2.1 development status.
3. A focused truth pass corrects only statements that no longer match shipped
   behavior.
4. A single `ask --contract` prints only its validated result object. On a
   strict rejection it prints that same object and exits non-zero.
5. Contracts persist an optional post-rejection prompt. The broker injects it
   with validation errors but does not await or capture an implicit retry.

**Exit criteria**
- All documentation links resolve from their new locations.
- User-facing documents describe the implemented product without stale
  release-era claims.
- Valid and rejected contract asks, direct shim output, and post-rejection
  delivery are covered by the broker harness.

---

## v1.3.0 — Iconography & JSON-Schema contracts

A polish-and-power release: the chrome drops every emoji/character glyph for a
consistent line-style SVG icon set, and contracts graduate from a required-field
list to a real JSON Schema with a bounded validate-until-valid loop.

**Expectation:** the app reads as one designed surface, and a contract lets one
agent hold another to an exact JSON shape without a human in the loop.

**Outputs**
1. **Iconography:** a single line-style SVG icon set (`src/app/icons.tsx`)
   replaces emoji/character glyphs across the palette, sidebar, terminal/note/
   portal/preview nodes, floors, composer, File Tree, and the config and align
   menus. The sidebar carries the Dogwalker mark, and its wordmark when expanded.
2. **Workspaces lose the icon field:** gone from the rail (collapsed rail shows
   name initials), the workspace card, and the create/edit form.
3. **Preset icons:** presets pick from a fixed set of built-in SVG glyphs instead
   of a free-form emoji field, stored as an icon id; built-in presets can be
   duplicated and deleted (hidden via a persisted set, never below one preset).
4. **JSON-Schema contracts:** a contract holds a JSON Schema, a max-attempts
   budget, a per-attempt timeout, a rejection prompt and a fallback value.
   `ask --contract <name>` runs a bounded loop — validate the peer's JSON answer
   with Ajv, re-ask with the rejection prompt and the errors on a miss, and return
   the validated object or, once attempts run out, the fallback. Removes
   `--strict`, the `instructions` field and the required-field model; renames
   "response contracts" to "contracts" everywhere.
5. **Contract CLI:** `dogwalker contract list|inspect|create|edit|delete` lets an
   agent manage the workspace's contracts (schema/attempts/timeout/rejection/
   fallback) itself; the agent skill documents it.
6. **Test stack:** adopt Vitest (unit + component, colocated `*.test.ts[x]`, node
   + jsdom with React Testing Library) and Playwright (`e2e/`), migrating the
   in-app `DW_*TEST` harnesses to behavior tests on the files under test. Portal
   automation stays an Electron integration check; the perf/scale probe stays a
   probe. `npm test` gates CI.

**Exit criteria**
- No emoji or character glyph remains as a chrome icon.
- A contract's JSON Schema validates a live agent answer and returns the
  configured fallback when the attempt budget is exhausted — no hang, no error.
- A single `ask --contract` prints just the value object, not an envelope.
- `npm test`, `npm run typecheck` and `npm run lint` are green.

---

## v1.3.1 — CI Node bump

A release-engineering patch: v1.3.0's test/build dependencies (Vitest, jsdom,
`@testing-library/jest-dom`, Electron 43) require Node 22+, and the lockfile is
generated with the npm that ships with Node 24. The CI `build` workflow now runs
on Node 24 (was 20) so `npm ci`, `npm test` and `npm run make` match local and CI.

**Exit criteria**
- The tag build workflow completes green and attaches each OS's installer to the
  GitHub Release.

---

## v1.3.2 — Spawn-time role ordering

A bug-fix patch. Creating a terminal with both a preset and a role injected the
role immediately, but the preset command only auto-runs after the shell has had a
moment to initialize — so the role prompt landed in the bare shell before the
agent launched. A spawn-time role is now deferred: the preset command starts the
agent first, and the role is injected only after the agent has booted and gone
quiet, so it reads its role rather than the shell swallowing it. Runtime role
(re)assignment to an already-running agent is unchanged.

**Exit criteria**
- A terminal spawned with a preset and a role shows the agent starting first, then
  the role prompt — verified by a real-PTY ordering test.

---

## v1.3.3 — Composer, portal & leash fixes

A bug-fix patch covering three canvas interactions:

- **Composer clears on send.** A keystroke schedules a debounced draft write; if
  the message was sent before it fired, the stale timer resurrected the sent text
  as the draft, so it reappeared when the terminal was next selected. The pending
  write is now cancelled on send.
- **Portals respect layering.** A portal is a native `WebContentsView` painted
  above the whole DOM, so it covered the minimap, floating menus and modals. Each
  portal's native bounds are now clipped to the largest rectangle that avoids every
  on-screen overlay (`portalOcclusion.ts`), and a portal fully covered by a modal
  scrim is hidden — the DOM chrome always stays on top.
- **Connections are removable.** A leash now shows a remove control at its midpoint
  (on hover or when selected); deleting routes through `onEdgesDelete`, which
  disconnects the pair in the broker.

**Exit criteria**
- Sending clears the box and leaves no draft behind (unit test).
- A portal never paints over the minimap, an open menu or a modal.
- A leash can be removed from the canvas without the keyboard.

---

## v1.4.0 — App themes, open composer & schema tree

The first post-1.0 minor: three interaction upgrades.

- **App themes.** The theme menu gains named app (UI chrome) palettes — Dogwalker
  Dark, Dim and Dogwalker Light — separate from terminal themes. An app theme is a
  set of `--dw-*` token overrides applied to the document root (`appThemes.ts`), so
  the background, sidebar, menus, notes, leashes, buttons, icons and wordmark
  recolor together. Persisted as `settings.appTheme`.
- **Open composer.** The composer is no longer bound to the selected terminal.
  It's an open chat: `@<name>` mentions one or more live terminals, and the full
  text — mentions included, never split — is delivered verbatim to each mentioned
  terminal, so addressing several at once lets each agent see what the others were
  told. Recipients are derived from the text; send is disabled until one is set.
- **Schema tree editor.** A contract's JSON Schema is edited in a themed,
  collapsible tree (`JsonTreeEditor`) — objects and arrays fold, and each field's
  key, type and value is editable inline — with a raw-JSON toggle as an escape
  hatch.

**Exit criteria**
- Switching app theme recolors the whole chrome, light and dark, and persists.
- A message @mentioning several terminals reaches each verbatim; none is sent
  when nothing is mentioned.
- A schema can be built and edited entirely in the tree, and round-trips through
  the raw-JSON view.

---

## v1.4.1 — Theme tokenization & composer polish

A follow-up fixing what v1.4.0 shipped rough.

- **One theme, not two.** The separate app-theme and terminal-theme concepts
  collapse into a single Theme. The chrome's `--dw-*` tokens are *derived* from the
  selected theme's palette (`themeChrome.ts`: surfaces/text are mixes toward the
  palette's own bg/fg, so contrast holds), and applied alongside the terminal
  colors. Every built-in and custom theme themes the app for free.
- **Full chrome tokenization.** Most surfaces, borders, text, buttons, the canvas
  grid and note nodes were hardcoded hex/rgba, so switching theme changed almost
  nothing. They now read the tokens (buttons get readable `--dw-on-accent` ink;
  the grid dots/background, notes and floating panels recolor).
- **Composer mentions read inline.** The left-hand recipient indicator and its
  hint text are removed; instead each `@mention` is tinted in the accent color as
  you type, drawn by a highlight overlay behind the transparent textarea and
  theme-aware like everything else.

**Exit criteria**
- Selecting a light theme visibly recolors the sidebar, menus, canvas grid, notes
  and composer — the terminals and chrome move together.
- Typing `@name` tints that token; no recipient name is shown on the left.

---

## v1.5.0 — Universal --json & CodeMirror schema editor

The first feature minor after the 1.4 polish.

- **`--json` everywhere.** The flag was `ask`-only; it's now a universal output
  flag handled once in the shim — any verb (`list`, `check`, `note`, `portal`,
  `contract`, `recruit`, …) emits a `{ ok, data }` envelope with `--json`, so agents
  and scripts parse results reliably. The broker is untouched (client-side
  formatting). The agent skill is bumped to v6.
- **CodeMirror schema editor.** The hand-rolled JSON-Schema tree editor is replaced
  by a small CodeMirror 6 editor (`SchemaEditor`) with JSON syntax highlighting and
  a live linter (parse errors underlined + gutter marker). It's themed from the
  `--dw-*` tokens and sits flush, built on the CodeMirror already used by the file
  editor — no component to hand-maintain.
- **App icon + distribution groundwork.** The logo becomes the app/installer icon
  on every OS (a dev-only rasterizer, `tools/gen-icons.mjs`, generates the committed
  `.png`/`.ico`/`.icns`); notifications gain the icon and click-to-focus; packaged
  Windows/macOS builds auto-update from Releases via the free `update.electronjs.org`;
  and `packaging/` adds Homebrew-cask / Scoop / AUR manifests (the low-friction,
  unsigned, no-gate channels — winget/choco/apt/Snap/Flatpak deferred).

**Exit criteria**
- `dogwalker <verb> … --json` returns a valid `{ ok, data }` envelope for every
  verb; plain output is unchanged.
- A contract's schema can be written and validated in the editor, with malformed
  JSON flagged inline.

---

## v1.5.1 — Design-system polish

A small polish patch.

- **Themed scrollbars & checkboxes.** Both are restyled to the `--dw-*` design
  tokens (custom webkit scrollbars; `appearance: none` checkboxes with a drawn,
  accent-filled tick), so they match the chrome and recolor with the theme instead
  of using the browser defaults.
- **Dev palette placement.** The dev-only palette moves from the top-left corner to
  centered just below the common palette.
- **README badges.** Status badges (release / build / license) and per-OS install
  badges (macOS · Homebrew, Windows · Scoop, Linux · AUR).
- Panel section headings collapse onto one consistent `.dw-section-head` style.

**Exit criteria**
- Scrollbars and checkboxes look native to Dogwalker and change with the theme.
- The dev palette no longer overlaps the top-left chrome.

---

## v1.5.2 — Distribution automation

Wire the package-manager channels into the tag-based CD.

- **`publish-packaging` job.** After the tag build attaches every OS's installers
  to the Release, a job downloads the artifacts, computes their checksums, and
  bumps each channel to the new version from the `packaging/` templates: the
  Homebrew cask and Scoop manifest are pushed to their tap/bucket repos, and the
  AUR `dogwalker-bin` package is published via the deploy action.
- **Guarded by secrets.** Each channel is skipped unless its secret is set
  (`PACKAGING_TOKEN` for Homebrew/Scoop; `AUR_SSH_PRIVATE_KEY` + `AUR_USERNAME` +
  `AUR_EMAIL` for the AUR), so the job is a green no-op until the taps/keys exist.
  One-time setup is documented in `packaging/README.md`.

**Exit criteria**
- A `v*` tag with the secrets configured updates all three channels to the new
  version with correct checksums; without them, the release is unaffected.

---

## v1.5.3 — Packaged UI load & Gatekeeper docs

Hotfix for the first public packaged builds.

- **Black screen.** Strip Vite's `crossorigin` from the packaged renderer HTML and
  keep `OnlyLoadAppFromAsar` off so `file://`/`asar` loads the UI bundle and the
  unpacked `node-pty` native addon.
- **Gatekeeper wording.** Document that recent macOS reports unsigned downloads as
  "damaged" (quarantine), cleared with `xattr`.

**Exit criteria**
- A packaged `.app` / installer paints the canvas UI after clearing quarantine.
- README matches the Gatekeeper dialog users actually see.

---

## v1.5.4 — PTY spawn-helper, renderer protocol & macOS name

Hotfix for local spawn, the still-black packaged window, and branding polish.

- **`posix_spawnp failed`.** Ensure node-pty's `spawn-helper` is executable after
  install (and at boot). Patch the packaged `unixTerminal.js` so asar unpack
  rewriting cannot produce `app.asar.unpacked.unpacked`.
- **Packaged UI protocol.** Load the Vite renderer via `dogwalker://` (privileged
  custom scheme) instead of `file://`+asar. `DOGWALKER_DEBUG=1` opens DevTools.
- **macOS display name.** Keep lowercase `executableName` for Linux AppImage, but
  stamp `CFBundleDisplayName`/`CFBundleName` as Dogwalker and call `app.setName`.

**Exit criteria**
- `npm start` can spawn a shell node without `posix_spawnp failed`.
- A packaged build paints the UI; `DOGWALKER_DEBUG=1` opens DevTools on the binary.
- Packaged macOS app shows **Dogwalker** in the menu bar / Dock, not `dogwalker`.

---

## v1.5.5 — Asar-safe shim copy

Hotfix for the packaged black screen: `createShimDir` stalled on
`fs.copyFileSync` from an asar source.

- **Asar-safe copy.** Replace `fs.copyFileSync` with read+write so the copy
  always completes or throws before `loadURL`.

**Exit criteria**
- Packaged app reaches `loadURL` (no hang in `createShimDir`).

---

## After v1 (parked, unscheduled)

Recurring ideas deliberately not on the path: community preset/skill sharing,
`--json` on every remaining verb, and tier-4 rendering if profiling demands it.
New scope enters [PRODUCT.md](PRODUCT.md) first, then lands here — never the other
way around.
