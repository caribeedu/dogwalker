<div align="center">

<img src="assets/hero.svg" alt="Dogwalker — walk all your agents at once" width="860">

An infinite canvas for AI coding agents: real terminals as nodes on a zoomable 2D surface. Put them on a leash — wire terminals together and your agents talk to each other through a structured protocol.

<p>
  <a href="https://github.com/caribeedu/dogwalker/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/caribeedu/dogwalker?label=release&labelColor=1b1b23&color=e8b565"></a>
  <a href="https://github.com/caribeedu/dogwalker/actions/workflows/build.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/caribeedu/dogwalker/build.yml?label=build&labelColor=1b1b23&color=e8b565"></a>
  <a href="#license"><img alt="License: MIT" src="https://img.shields.io/github/license/caribeedu/dogwalker?labelColor=1b1b23&color=e8b565"></a>
</p>

<p>
  <a href="#install"><img alt="macOS — Homebrew" src="https://img.shields.io/badge/macOS-Homebrew-e8b565?logo=apple&logoColor=white&labelColor=1b1b23"></a>
  <a href="#install"><img alt="Windows — Scoop" src="https://img.shields.io/badge/Windows-Scoop-e8b565?logo=windows&logoColor=white&labelColor=1b1b23"></a>
  <a href="#install"><img alt="Linux — AUR" src="https://img.shields.io/badge/Linux-AUR-e8b565?logo=archlinux&logoColor=white&labelColor=1b1b23"></a>
</p>

[Why](#why) · [Features](#features) · [Install](#install) · [Quick start](#quick-start) · [Compatibility](#compatibility) · [Architecture](#architecture) · [Documents](#documents) · [Privacy](#privacy) · [License](#license)

</div>

---

## Why

Running multiple AI coding agents today means a pile of terminal tabs: no spatial context, no way for agents to cooperate, no view of the whole operation. Existing "agent canvas" tools are paid.

Dogwalker gives you one infinite canvas per project where every terminal is a live node. Zoom out and watch your team of agents work; zoom in and talk to one. Connect two terminals and their agents can message each other, review each other's code, and share notes — through a real request/response protocol (the asker gets the target's captured output back), not brittle screen scraping.

```
        ┌──────────┐    ask →     ┌──────────┐
        │  Claude   │◄────────────►│  Codex    │
        │  (Lead)   │              │  (Coder)  │
        └────┬─────┘              └────┬─────┘
             │ reads/writes            │ check
        ┌────▼─────┐              ┌────▼─────┐
        │ SPEC.md   │              │ dev server│
        │ (note)    │              │ (terminal)│
        └──────────┘              └──────────┘
```

## Features

- **Inter-agent messaging** — wire terminals and agents use the `dogwalker` CLI (alias: `walk`) to `ask` each other; the asker gets back whatever the target produced (no cooperation or reply command needed). Click any leash to see the full message history.
- **Portals** — isolated embedded browsers agents can drive: navigate, click, type, screenshot, run JS, read DOM and console. Link portals to share sessions.
- **Floors** — parallel isolated copies of your repo via git worktrees, each with its own canvas layer and terminals; "Land" merges back when done. Setup/teardown hooks included.
- **Routines** — scheduled prompts (single or `&&`-chained) on any agent, for recurring tests, health checks, review sweeps.
- **Workspaces** — per-project canvases with saved layouts, background operation, and one-click hibernation.
- **File Tree** — embedded file manager with list/grid/git-diff/git-graph views, drag-to-agent, and a built-in code editor.
- **Roles & presets** — persist reusable launch commands and Markdown role
  instructions locally. A role on a live terminal gets a readable context file
  without dropping its leashes; deleted configuration has a direct replacement
  control.
- **Notes** — markdown files on disk rendered as sticky notes; agents read and edit connected notes; chain notes into mind-maps.
- **Prompt Composer** — floating rich-text input with @-mentions of terminals/notes/portals and image paste (delivered to agents as file paths — works with every major agent CLI).
- **`check` anything** — agents can read the live screen of *any* connected terminal: another agent, a build, a dev server, a log tail.
- **Team operations** — ask every connected teammate with `dogwalker ask --all`;
  each result is independently authorized and returned as a compact JSON
  envelope. A single contract ask returns only its validated result
  object; contracts can also send a configurable post-rejection prompt to the
  agent when its output misses the agreed shape.
- **Infinite canvas** — Figma-style pan/zoom, groups, snapping, align/tidy, minimap.
- **Real terminals** — actual PTYs with GPU-accelerated rendering, 1–9 quick-jump, themes, per-terminal memory limits. Terminals stay visibly alive at every zoom level.
- **Walker mode** — promote an agent to manager: it recruits, wires, re-roles, and dismisses its own team via CLI.

## Install

### From a packaged build (recommended)

**Requirements:** `git` on your PATH (for Floors and the git views).

Grab the installer for your OS from the [latest release](https://github.com/caribeedu/dogwalker/releases/latest):

| OS | Artifact |
|---|---|
| Windows 10/11 | `Dogwalker-<version>.Setup.exe` |
| macOS 13+ | `Dogwalker-<version>.dmg` |
| Linux | `Dogwalker-<version>.AppImage`, or the `.deb` / `.rpm` |

Unsigned for now: Windows SmartScreen ("More info → Run anyway") and macOS
Gatekeeper will warn on first launch. On recent macOS (Sequoia / macOS 15+),
Gatekeeper often labels an unsigned download as **"damaged"** rather than
"unidentified developer" — that is the quarantine flag, not a corrupt file.
Clear it with:

```bash
xattr -dr com.apple.quarantine /Applications/Dogwalker.app
```

(`xattr -cr` on the `.app` also works.) Then open normally. Code signing +
notarization are tracked for a later release.

Packaged Windows/macOS builds **auto-update** from the latest release. Package-manager installs — Homebrew (macOS), Scoop (Windows), AUR (Linux) — are set up under [`packaging/`](packaging/); the `brew` / `scoop` / AUR commands land here once their taps are published.

### From source

**Requirements:** Node.js 20+ and `git`.

```bash
git clone https://github.com/caribeedu/dogwalker
cd dogwalker
npm install
npm start
```

Build your own installers with `npm run make` (produces your current OS's artifact under `out/make/`).

## Quick start

1. **Create a workspace** — point it at a project directory.
2. **Draw a terminal** — pick the Terminal tool, drag a rectangle, choose an agent preset (or a plain shell).
3. **Draw a second terminal**, then **connect them** — select one, press the connection shortcut, click the other.
4. **Ask across the wire** — in terminal A's agent, type: *"use dogwalker to ask Reviewer to look at auth.ts"*. The agent runs `dogwalker ask reviewer "…"`; Dogwalker delivers the message, waits for the reviewer to finish, and hands its output straight back to A — the reviewer just responds normally, no reply command needed.
5. **Watch** — zoom out; attention dots light up when an agent finishes and waits for you.

## Compatibility

### AI agents

Any tool launchable as a command works — an agent is just a command in a terminal. Shipped presets:

| Agent | Messaging (`ask`) | Images via composer | Notes/Portals via CLI |
|---|---|---|---|
| Claude Code | ✅ | ✅ (file path) | ✅ |
| Codex CLI | ✅ | ✅ (file path) | ✅ |
| Gemini CLI | ✅ | ✅ (file path) | ✅ |
| Any script / plain shell | Connected AI agents can watch this terminal's live screen via `check` (builds, dev servers, log tails); the script itself can also call the CLI | — | ✅ |

Agents learn the CLI through a skill installed in your agent-skills folder — no per-vendor integration, no MCP configuration.

### Platforms & terminals

| | macOS 13+ | Windows 10/11 | Linux |
|---|---|---|---|
| PTY backend | node-pty (forkpty) | node-pty (ConPTY) | node-pty (forkpty) |
| Shells | zsh, bash, fish | PowerShell, WSL | bash, zsh, fish |
| GPU terminal rendering | ✅ | ✅ | ✅ |
| Floors (git worktree) | ✅ | ✅ | ✅ |
| QA verified (through v0.7) | pending | ✅ | pending |

## Architecture

Electron app, two halves: a **host daemon** (main process) owning PTYs, the IPC socket, the message broker, portals (CDP), floors, and routines — and a **canvas UI** (renderer) built on React Flow with xterm.js terminal nodes. The `dogwalker` CLI available inside canvas terminals is a thin shim over the daemon's socket; **all** agent-facing capability flows through one broker, gated by the connection graph.

Highlights worth reading about:

- [Terminal rendering degradation ladder](docs/ARCHITECTURE.md#4-terminal-rendering-the-degradation-ladder) — how dozens of live terminals stay smooth on a zoomable canvas.
- [The ask protocol](docs/ARCHITECTURE.md#5-the-ipc-bus--dogwalker-cli) — structured messaging via captured output, with atomic bracketed-paste injection.
- [Attention detection](docs/ARCHITECTURE.md#6-attention-detection) — OSC 133 shell integration instead of vendor heuristics.
- [Floors on git worktrees](docs/ARCHITECTURE.md#8-floors-git-worktrees) — cross-platform parallel workspaces.

## Documents

| Document | Purpose |
|---|---|
| [PRODUCT.md](docs/PRODUCT.md) | What Dogwalker is — every feature, core concepts, compatibility targets, and non-goals. |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it's built — stack, process model, the IPC broker and CLI protocol, terminal rendering, floors, portals, persistence, security. |
| [ROADMAP.md](docs/ROADMAP.md) | The version path and each version's expectation, outputs, and exit criteria. |
| [CHANGELOG.md](docs/CHANGELOG.md) | Notable changes per release, newest first. |
| [DESIGN.md](docs/DESIGN.md) | The visual language — brand, color tokens, type, shape, components. |
| [ANNOUNCEMENT.md](docs/ANNOUNCEMENT.md) | The public launch post. |
| [CONTRIBUTING.md](docs/CONTRIBUTING.md) | How to run from source, how the code is tested, and the ground rules. |
| [AGENTS.md](AGENTS.md) | Guide for AI agents working on this codebase — invariants and conventions. |

## Privacy

Everything runs locally. No accounts, no telemetry, no cloud services. Notes are plain markdown on your disk; workspace layouts are plain JSON.

## License

Free and open source. License file to be added (MIT intended).

Contributions and issue reports welcome — see [CONTRIBUTING.md](docs/CONTRIBUTING.md). Bugs and ideas go through the [issue templates](.github/ISSUE_TEMPLATE); the version path is in [ROADMAP.md](docs/ROADMAP.md).
