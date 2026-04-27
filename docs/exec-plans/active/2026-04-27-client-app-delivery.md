# Client App Delivery — Workspace + Directory Restructure

## Background

Career-ops currently ships three independently developed surfaces:

- `bridge/` — Fastify local HTTP companion that brokers Claude/Codex evaluations
  and exposes scan/job-store APIs to the extension.
- `extension/` — Chrome MV3 extension (popup, background, panel, content,
  autofill).
- `web/` — static dashboard generator plus a small loopback `dashboard-server.mjs`
  that serves the dashboard, generates Apply-Next PDFs, and proxies a few
  bridge calls so the dashboard can act on the tracker.

Each lives at the repo root with its own `package.json` and ad-hoc relative
imports. As the product evolves toward a single client app, the directory
layout and process model need to converge:

1. Adopt a pnpm workspace so `apps/` houses the shipped surfaces and `packages/`
   can hold shared libraries.
2. Collapse the bridge + dashboard servers eventually so a single port hosts
   the dashboard UI and the evaluation API.
3. Prepare for an Electron-shell desktop wrapper later.

## Goal

Deliver a clean workspace skeleton and a single-port server merge while keeping
all existing flows green at every step.

## Scope

In scope (Stage 0):

- pnpm workspace skeleton (Task 0.1, already landed in `4ffde92`).
- Move `bridge/` → `apps/server/` and rename to `@career-ops/server`
  (Task 0.2).
- Move `extension/` → `apps/extension/` (Task 0.3).
- Inventory `web/dashboard-server.mjs` so Stage 3 can fold its routes into
  the server cleanly (Task 0.4).

Out of scope (other stages):

- Adapter cleanup (Stage 1), OpenRouter adapter (Stage 2),
  single-port dashboard merge (Stage 3), LaunchAgent quick win (Stage 4),
  Electron shell (Stage 5), final cleanup (Stage 6).

## Implementation Steps

1. Initialize pnpm workspace skeleton.
   Verify: `pnpm-workspace.yaml` lists `apps/*` and `packages/*`,
   `pnpm install` succeeds.
2. Move bridge → apps/server, rename package, update path refs and tests.
   Verify: `pnpm --filter @career-ops/server typecheck` and `test` pass.
3. Move extension → apps/extension, fix relative imports/tsconfig.
   Verify: `pnpm --filter @career-ops/extension typecheck` and `run build`
   produce dist/.
4. Inventory `web/dashboard-server.mjs` routes for Stage 3 reference.
   Verify: route table captured under Progress Log.

## Verification Approach

- Per-task targeted commands above.
- After Stage 0: `pnpm -r typecheck` clean across the workspace.
- Manual smoke-test: load extension dist/ in Chrome, run `npm run ext:bridge`,
  hit `/api/health` on dashboard.

## Progress Log

- 2026-04-27 — Task 0.1 (`4ffde92`): pnpm workspace skeleton — `apps/.gitkeep`,
  `packages/.gitkeep`, `pnpm-workspace.yaml`, lockfile, root `package.json`
  marker.
- 2026-04-27 — Task 0.2 (`becfa28`): moved `bridge/` → `apps/server/`,
  renamed package to `@career-ops/server`, updated path refs in root scripts,
  `verify-pipeline.mjs`, `scan.mjs`, `extension/tsconfig.json`,
  `extension/src/contracts/bridge-wire.ts`, scripts that import `../bridge/...`,
  test fixtures that walk up to repo root, and `.gitignore`. Server typecheck
  + 244 tests pass.
- 2026-04-27 — Task 0.3 (`4204a22`): moved `extension/` → `apps/extension/`,
  fixed relative paths in `bridge-wire.ts`/`tsconfig.json` to point at the
  sibling `../server/...`, switched root `ext:build` to
  `pnpm --filter @career-ops/extension run build`, updated `scripts/*` and
  `.gitignore`. Extension typecheck + build clean.
- 2026-04-27 — Task 0.4: inventoried `web/dashboard-server.mjs` routes for
  Stage 3 (single-port merge) reference. See route table below.

### Stage 0 Task 0.4 — web/dashboard-server.mjs route inventory

Port: 47329 (loopback) — env override `CAREER_OPS_PDF_PORT`. Bound to
`CAREER_OPS_PDF_HOST` (default `127.0.0.1`).
Auth: per-route via `assertApiToken(req)` which checks the `x-career-ops-pdf-token`
header against `process.env.CAREER_OPS_PDF_TOKEN` (or a per-process
`randomUUID()` fallback). The token is injected into the dashboard HTML at
`GET /` via an inline `<script>window.PDF_API_TOKEN=...</script>`. No middleware
chain — auth is checked inline at each handler.
CORS: a single `OPTIONS` preflight handler responds with
`access-control-allow-origin: *`,
`access-control-allow-methods: GET,POST,OPTIONS`,
`access-control-allow-headers: content-type,x-career-ops-pdf-token`.
Static: no static asset directory. The dashboard HTML is rendered in-process
via `renderDashboardHtml()` from `web/build-dashboard.mjs`. Reports are served
from `<repo>/reports/` only via the `/reports/{NNN-...}.md` route, with a
path-traversal guard (`abs.startsWith(reportsDir + sep)`).
Body parser: inline `readJsonBody(req)` — accumulates chunks, enforces 256 KiB
cap, parses JSON; throws `ClientError` on overrun or invalid JSON.
Startup behavior: on `startServer()` the process kicks off `runGmailRefresh({ trigger: 'dashboard-start' })`
(non-blocking) and logs the result. Reads `BRIDGE_TOKEN_PATH` lazily at request
time when proxying (`/api/full-evaluation*`).
Bridge proxy base: `CAREER_OPS_BRIDGE_BASE` (default `http://127.0.0.1:47319`).
Token read from `<repo>/bridge/.bridge-token` (NOTE: post Task 0.2 this path
needs updating to `apps/server/.bridge-token` — flagged for Stage 3 merge).

| Method | Path | Auth | Purpose | Input | Output |
|--------|------|------|---------|-------|--------|
| OPTIONS | * | none | CORS preflight | — | 204, CORS headers |
| GET | / | none | Render dashboard HTML with embedded API token | — | `text/html` (full dashboard, includes Gmail signals + profile) |
| GET | /index.html | none | Same as `/` | — | `text/html` |
| GET | /reports/{NNN-slug-YYYY-MM-DD}.md | none | Serve evaluation report markdown (regex `^\/reports\/\d{3}-.+\.md$`, traversal-guarded) | path | `text/markdown` or 404 JSON |
| GET | /api/health | none | Liveness + report downloads dir | — | `{ok, downloadsDir}` |
| POST | /api/apply-docs/generate | required | Generate CV or cover-letter PDF for an Apply-Next row; runs `generate-pdf.mjs` or `generate-cover-letter.mjs` via `runNodeScript`; stores doc in in-memory `docStore` keyed by sha256 id | JSON: `{type: 'cv'\|'cover-letter', company, role, score, notes, jobUrl, reportPath}` | `{ok, doc: {id, type, filename, outputPath}}` |
| POST | /api/apply-docs/download | required | Copy a previously generated doc from `output/` to `~/Downloads/` (auto-rename on collision) | JSON: `{id}` | `{ok, doc: {...originalDoc, savedPath}}` |
| POST | /api/apply-status | required | Toggle a tracker row's status between `Applied` and a terminal status set; rewrites `data/applications.md` in place | JSON: `{num, applied: boolean}` | `{ok, status, changed}` |
| POST | /api/full-evaluation | required | Queue a full evaluation against the bridge (`POST /v1/evaluate`); reads cached JD from `data/pipeline.md` + report URL; needs `bridge/.bridge-token` | JSON: `{reportPath, company, role, score, status, notes, jobUrl?}` | 202, `{ok, jobId, bridgeBase}` |
| POST | /api/full-evaluation/status | required | Poll bridge `/v1/jobs/{id}` snapshot, normalize into `{jobId, phase, updatedAt, error, result}` | JSON: `{jobId}` | `{ok, job: {...}}` |
| (any) | (other) | n/a | Fallback 404 | — | `{ok: false, error: 'not found'}` |

Side-effect notes for Stage 3:

- All POST handlers funnel through a shared try/catch that converts thrown
  `ClientError`s (with a `.status`) to the response status, otherwise 500.
- `assertApiToken` is fail-closed (401) with no rate limiting — fine for
  loopback but worth a note when single-porting onto the bridge.
- The bridge-proxy helpers (`postBridge`, `getBridge`) wrap the standard
  bridge envelope (`protocol: '1.0.0', requestId: dashboard-{uuid},
  clientTimestamp, payload`) and re-raise bridge errors as 502/503.
- Gmail refresh runs synchronously at boot via spawnSync; merging into the
  bridge keeps that behavior so the dashboard greeting still shows fresh
  Gmail signals.

## Key Decisions

- pnpm + workspaces (not npm workspaces) — matches the user's local toolchain
  (pnpm 10.30) and offers stricter hoisting semantics.
- `apps/server` rather than `apps/bridge`: `bridge` was a phase-1 name when
  the runtime was a thin shell over `claude -p`. The eventual single-port
  merge with `web/dashboard-server.mjs` makes "server" the right umbrella.
- `apps/extension` keeps the package name `@career-ops/extension` unchanged —
  no manifest churn, just a directory move.

## Risks and Blockers

- The bridge token path is hard-coded as `bridge/.bridge-token` in
  `web/dashboard-server.mjs`. Until Stage 3 absorbs the dashboard server, it
  must be updated to `apps/server/.bridge-token` — tracked here so Stage 3
  doesn't miss it.
- `verify-pipeline.mjs` switched to `pnpm --filter`; downstream automation
  that calls `npm run verify` from environments without pnpm needs to install
  pnpm or use `corepack`.

## Final Outcome

Stage 0 in progress. Tasks 0.1–0.4 complete. Stages 1–6 still pending.
