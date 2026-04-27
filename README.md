# Hongxi's Career-Ops

This is my personal Career-Ops workspace for evaluating jobs, tracking
applications, and running the local browser-extension workflow. It is based on
the upstream Career-Ops project, but this `main` branch is maintained for my own
workflow.

This repo is a decision and tracking system. It does not submit applications for
me.

## What It Does

- Captures job pages through the Chrome extension and local bridge.
- Scores roles with the existing Career-Ops modes and templates.
- Tracks application rows, reports, follow-ups, and local dashboard data.
- Builds a static dashboard at `web/index.html`.
- Keeps durable execution context in `docs/exec-plans/`.
- Keeps upstream Gemini CLI and LaTeX CV export entry points available.

## Daily Commands

```bash
npm install
npm run verify
npm run ext:build
npm run server
npm run dashboard
```

Useful entry points:

- `npm run server:dev` builds the extension and starts the bridge.
- `npm run ext:launcher` prints the local extension launch instructions.
- `npm run pending:warm-cache` warms legacy pending-job cache data.
- `npm run gemini:eval -- "JD text"` runs the upstream Gemini evaluator.
- `node generate-latex.mjs` runs the upstream LaTeX CV export path.

## Local Data

Private working data stays local and gitignored:

- `cv.md`
- `config/profile.yml`
- `modes/_profile.md`
- `article-digest.md`
- `portals.yml`
- `data/`
- `reports/`
- `output/`

Use templates when sharing setup:

- `config/profile.example.yml`
- `templates/portals.example.yml`
- `templates/`

## Main Docs

- `CLAUDE.md` is the main project instruction file for agents.
- `AGENTS.md` routes Codex to the same project rules.
- `GEMINI.md` covers upstream Gemini CLI integration.
- `modes/latex.md` covers upstream LaTeX CV export.
- `docs/CODEX.md` covers Codex-specific setup.
- `docs/BROWSER_EXTENSION.md` covers extension and bridge usage.
- `DATA_CONTRACT.md` defines tracker and report data expectations.
- `docs/exec-plans/README.md` explains execution-plan hygiene.
- `web/README.md` covers the dashboard files.

## Workflow Rules

- Keep user-specific customization out of shared modes.
- Store durable decisions in repo docs, not only in chat.
- Prefer mechanical checks over prose rules when a constraint repeats.
- Keep top-level files concise and move detailed material under `docs/`.
- Never submit an application automatically.

## Branch Policy

This fork uses direct pushes to my own `main` when I explicitly ask for them.
Upstream changes can be merged in, but personal data and local runtime artifacts
should stay out of commits.
