# Gmail Application Tracking Feature Plan

## Background

The user wants a Gmail-backed application tracking feature: track companies applied to, detect application status changes, surface interviews/OA/follow-ups, and keep the Career-Ops tracker current.

Current Career-Ops is a local, repository-first job search system. The canonical tracker is `data/applications.md`; follow-up cadence is computed by `followup-cadence.mjs`; dashboard data is built from repository files by `web/build-dashboard.mjs`; status writes must use existing tracker rules from `CLAUDE.md`.

The design question is whether to:

- use the Codex Gmail skill/connector directly, or
- build a first-party Gmail OAuth integration and scan Gmail through the Gmail API.

## Goal

Choose the safest and simplest implementation path for Gmail-driven application tracking, then define an execution plan that can be implemented without creating a parallel tracker or overbuilding product infrastructure too early.

## Success Criteria

- Gmail-derived application signals become durable repository artifacts before they affect tracker decisions.
- `data/applications.md` remains the only canonical application tracker.
- The first implementation can run locally for the current user without Google OAuth app verification or production backend infrastructure.
- The design leaves a clear upgrade path to first-party Gmail OAuth if Career-Ops becomes a multi-user product.
- Every status-changing path has tests or a reproducible dry-run check before it mutates tracker state.

## Assumptions

- The immediate target is this repository's local/personal Career-Ops workflow, not a hosted multi-user SaaS.
- The user wants recommendations and tracking, not automatic application submission.
- Gmail read access is needed only to detect hiring/application events; sending, deleting, archiving, and labeling are not part of this feature.
- Codex Gmail skill access is acceptable for local/manual runs, but its results must be written into repo files before they are treated as system state.
- If the feature later becomes a product for external users, first-party Gmail OAuth becomes mandatory.

## Uncertainties

- Whether the eventual UI should live only in the existing dashboard or become a separate web app.
- Whether the user needs fully automatic background sync, or whether an explicit local command is enough.
- Whether Gmail metadata is enough for useful triage, or whether body snippets/full bodies are required for OA deadlines and interview scheduling.
- Whether the project should store raw email snippets, derived event facts only, or both.

## Recommendation

Use a two-stage path.

Stage 1 for this repository: use Codex Gmail skill as the Gmail read adapter, but never as the product state store. Write derived signals into versioned repo artifacts and merge them into existing tracker/follow-up flows through scripts with dry-run and tests.

Stage 2 for a real product: build first-party Gmail OAuth, token storage, background sync, Pub/Sub/history-based incremental sync, privacy controls, and Google verification/security review readiness.

Do not start by building Gmail OAuth inside this repo unless the actual goal is a hosted multi-user product. That would introduce auth, token storage, Pub/Sub, background workers, cloud deployment, privacy policy, user deletion, and Google restricted-scope review before the local tracker model is proven.

## Scope

In scope for the first implementation:

- Define a repository-owned email signal artifact.
- Add a parser/importer that converts Gmail search/read results into normalized application events.
- Reuse canonical tracker statuses from `templates/states.yml`.
- Reuse `data/applications.md`, `data/follow-ups.md`, `followup-cadence.mjs`, and dashboard parsing.
- Add tests for classification, deduplication, exact/ambiguous matching, and dry-run mutation behavior.
- Add dashboard visibility for application attention items if the existing dashboard is the chosen UI surface.

Not in scope for the first implementation:

- Hosted multi-user OAuth.
- Google Cloud Pub/Sub.
- Persistent token storage.
- Gmail write operations.
- Automatic sending of follow-up emails.
- Raw mailbox archival inside the repository.

## What Already Exists

- `data/applications.md`: canonical application tracker; statuses must remain canonical.
- `templates/states.yml`: canonical status source.
- `merge-tracker.mjs`: merge path for new application rows.
- `verify-pipeline.mjs`: structural tracker health check.
- `followup-cadence.mjs`: existing follow-up urgency calculation for active applications.
- `data/follow-ups.md`: follow-up history once a user confirms an action was sent.
- `web/build-dashboard.mjs`: dashboard data builder from repository files.
- `web/dashboard-server.mjs`: local server that already mutates tracker status for dashboard actions.
- Gmail skill: existing interactive mailbox search/read/triage capability, explicitly designed around Gmail-native search and read-only-first workflows.

The plan should reuse these. A new Gmail feature should not create a second application database, a second status model, or a separate follow-up engine.

## Step 0 Scope Challenge

1. Existing code already solves tracker state, follow-up cadence, dashboard rendering, status validation, and merge/dedup concerns. The missing piece is an email-signal ingestion layer, not a new tracker.
2. Minimum viable change: create a derived signal artifact plus an importer/classifier and wire its output into existing tracker/follow-up/dashboard flows.
3. Complexity smell: first-party OAuth would likely add more than 8 files and more than 2 services/classes before a single application event is useful. For the current repo, that is overbuilt.
4. Search check:
   - [Layer 1] Gmail API has built-in full sync, partial sync via `history.list`, and push notifications via `users.watch`; use those if/when building product sync.
   - [Layer 1] Gmail scopes should be as narrow as possible; `gmail.readonly` and `gmail.metadata` are restricted scopes.
   - [Layer 1] Gmail push watches expire and must be renewed at least every 7 days; Google recommends daily renewal.
   - [Layer 1] Gmail history records can expire; clients must fall back to full sync on out-of-range history.
5. `TODOS.md` has no existing item that blocks this feature.
6. Completeness check: the complete local version is not OAuth. The complete local version is a durable, tested signal pipeline that can later swap the Gmail source adapter.
7. Distribution check: no new artifact type is required for Stage 1. If Stage 2 becomes a hosted service, deployment, OAuth verification, and data deletion workflows become required scope.

## Architecture Review

Recommended Stage 1 architecture:

```text
Codex Gmail skill / Gmail connector
        |
        | read-only search + selected message/thread reads
        v
operator-reviewed Gmail signal JSON/Markdown
        |
        v
scripts/import-gmail-signals.mjs --dry-run
        |
        +--> normalized email events
        |       - company
        |       - role
        |       - event type
        |       - event date
        |       - confidence
        |       - source message id/thread id
        |       - recommended tracker action
        |
        +--> exact matches update existing tracker rows
        |
        +--> ambiguous/new rows go to review queue
        |
        v
data/applications.md + data/follow-ups.md + dashboard
```

Recommended Stage 2 architecture if this becomes a product:

```text
User browser
   |
   v
OAuth consent
   |
   v
Backend API ------ encrypted token store
   |
   v
Gmail Sync Worker
   |
   +--> initial scan: messages.list / threads.list + messages.get
   |
   +--> incremental sync: users.watch -> Pub/Sub -> history.list
   |
   +--> fallback resync: recent-window scan / full sync on 404 history
   |
   v
Parser / classifier
   |
   v
Applications / events / attention items DB
   |
   v
Application tracker UI
```

Architecture decision: Stage 1 should define a Gmail source boundary so the Gmail skill can be replaced later by OAuth without rewriting tracker logic.

Production failure scenario for Stage 1: Gmail search returns only a sampled/narrowed set and misses a rejection. Mitigation: record query scope and confidence in the signal artifact, and do not claim comprehensive mailbox state unless the scan scope supports it.

Production failure scenario for Stage 2: Pub/Sub notification is delayed/dropped or `historyId` expires. Mitigation: store last known `historyId`, process `history.list`, and run periodic fallback sync; on Gmail 404, perform a bounded full sync.

## Code Quality Review

Keep the implementation boring and explicit:

- Add one importer script first; avoid a service framework.
- Keep matching logic as pure functions that can be unit tested.
- Keep Gmail-specific parsing separate from tracker mutation.
- Require `--dry-run` output before any tracker write.
- Preserve existing status normalization and tracker rules instead of reimplementing them.
- Store only derived facts by default; avoid raw email bodies unless a later requirement proves they are needed.

Likely files for Stage 1:

- `scripts/import-gmail-signals.mjs` or root-level `import-gmail-signals.mjs`, following existing script style.
- `data/gmail-signals.md` or `data/gmail-signals.jsonl` for derived, reviewed events.
- `data/gmail-review-queue.md` for ambiguous matches.
- targeted tests in the existing `test-all.mjs` pattern, or a focused Node test if the repo adds one.
- optional dashboard changes in `web/build-dashboard.mjs` and `web/template.html`.

If the first implementation touches more than the importer, one data artifact, tests, and optional dashboard rendering, reassess scope.

## Test Review

Detected test infrastructure:

- `package.json` exposes `npm run verify`, `npm run dashboard:build`, and `test-all.mjs`.
- `CLAUDE.md` says GitHub Actions run `test-all.mjs`.
- Existing scripts are plain Node `.mjs` modules.

Coverage diagram for Stage 1:

```text
CODE PATH COVERAGE TO ADD
=========================
[+] Gmail signal loader
    |
    +-- [GAP] valid signal file -> parsed events
    +-- [GAP] missing/empty signal file -> no-op with clear output
    +-- [GAP] malformed event -> validation error, no tracker write

[+] Event classifier
    |
    +-- [GAP] application confirmation -> Applied candidate
    +-- [GAP] recruiter response -> Responded candidate
    +-- [GAP] interview/OA scheduled -> Interview or attention item
    +-- [GAP] rejection/closed role -> Rejected/Discarded candidate
    +-- [GAP] ambiguous subject/body -> review queue, no mutation

[+] Tracker matcher
    |
    +-- [GAP] exact company + role match -> update existing row only
    +-- [GAP] company match + role mismatch -> review queue
    +-- [GAP] no existing row -> review queue or TSV addition, not direct append
    +-- [GAP] terminal status already set -> do not downgrade

[+] Tracker writer
    |
    +-- [GAP] --dry-run -> proposed diff only
    +-- [GAP] write mode -> surgical row update
    +-- [GAP] write failure -> no partial corrupt tracker

USER FLOW COVERAGE TO ADD
=========================
[+] Local scan/review/import flow
    |
    +-- [GAP] user runs Gmail search through skill -> saves derived signals
    +-- [GAP] user previews importer dry-run -> sees exact vs ambiguous actions
    +-- [GAP] user applies exact updates -> verify-pipeline passes
    +-- [GAP] user opens dashboard -> attention items/status changes visible

[+] Error and recovery states
    |
    +-- [GAP] Gmail unavailable -> explain reconnect/manual export path
    +-- [GAP] duplicate email signal -> idempotent no-op
    +-- [GAP] stale signal from old scan -> skipped or marked stale
    +-- [GAP] conflicting signals -> review queue

─────────────────────────────────
COVERAGE TARGET: 0/22 paths currently covered by feature-specific tests
QUALITY TARGET: all matcher/classifier branches get behavior tests before write mode lands
E2E TARGET: one dry-run-to-verify flow using fixture data
─────────────────────────────────
```

Test requirements:

- Add fixtures for common hiring email types: applied, OA, interview, rejection, action required, newsletter/noise, ambiguous company.
- Test idempotency by importing the same signal twice.
- Test status monotonicity so `Rejected`/`Offer`/`Discarded` are not overwritten by later generic confirmations.
- Test exact-vs-ambiguous matching.
- Test that no new rows are appended directly to `data/applications.md`.
- Run `node verify-pipeline.mjs` after any tracker mutation.
- Run `npm run dashboard:build` if dashboard rendering changes.

## Performance Review

Stage 1 performance risks are low because the Gmail skill search is user-triggered and bounded. The importer should still:

- process signal files linearly,
- avoid loading unnecessary raw email bodies,
- avoid repeated full tracker parsing inside loops,
- keep dry-run output compact,
- deduplicate by Gmail message/thread id plus event type.

Stage 2 performance risks are material:

- Gmail full sync can be expensive; use bounded historical windows for this product's purpose.
- Pub/Sub can redeliver notifications; worker must be idempotent.
- Gmail notification rate is limited per watched user; avoid feedback loops.
- History records can expire; fallback sync must avoid unbounded mailbox scans.

## Failure Modes

| Codepath | Failure | Test? | Handling? | User-visible? | Critical Gap |
|---|---|---:|---:|---:|---:|
| Signal loader | malformed signal artifact | planned | planned | clear error | no |
| Event classifier | false positive newsletter as application | planned | review queue under low confidence | yes | no |
| Tracker matcher | wrong role matched at same company | planned | require exact role or review queue | yes | no |
| Tracker writer | partial write corrupts markdown | planned | write temp/validate before replace | yes | no |
| Gmail scan scope | missed important email | planned via scope logging | partial; cannot guarantee | yes, confidence note | no |
| OAuth sync Stage 2 | expired historyId | future | full/resync fallback required | yes | yes if Stage 2 skips fallback |
| OAuth sync Stage 2 | token revoked | future | reconnect state required | yes | yes if Stage 2 skips reconnect UX |

## NOT In Scope

- First-party Gmail OAuth in the first local implementation: too much infrastructure before the signal model is proven.
- Multi-user hosted product backend: different architecture and compliance burden.
- Gmail write actions: not needed for tracking and increases risk.
- Auto-sending recruiter follow-ups: violates review-before-send expectations.
- Full mailbox archival: unnecessary and privacy-heavy.
- Automatic tracker row creation from email alone: use existing TSV merge flow or review queue.

## Implementation Steps

1. Define the Gmail signal artifact.
   Verify: sample fixture file validates and records query scope, account, timestamp, and source message/thread ids.
2. Build pure classifier/matcher functions.
   Verify: fixture tests cover all event types, ambiguity, duplicate signals, and terminal-status protection.
3. Build importer dry-run.
   Verify: dry-run shows exact updates, review queue entries, and no file mutation.
4. Add write mode for exact existing-row updates only.
   Verify: `node verify-pipeline.mjs` passes after a fixture-backed mutation.
5. Wire follow-up/attention output.
   Verify: `node followup-cadence.mjs --summary` still works and attention items are visible in the chosen artifact or dashboard.
6. Optional dashboard display.
   Verify: `npm run dashboard:build` succeeds and the dashboard renders the new derived data.

## Verification Approach

- Use fixture-driven tests for all classifier and matcher branches.
- Use dry-run snapshots for proposed tracker changes.
- Use `node verify-pipeline.mjs` after any tracker write.
- Use `npm run dashboard:build` for dashboard changes.
- Record Gmail query scope and scan limitations in every run artifact.

## Key Decisions

- Decision: For this repo, use Gmail skill/connector as the Stage 1 read adapter instead of building OAuth first.
  Rationale: Career-Ops is currently local and repository-first; OAuth adds production infrastructure and Google verification concerns before the local model is validated.
- Decision: Make derived email signals durable in repo artifacts before they drive tracker updates.
  Rationale: The repository is the only durable system of record.
- Decision: Only exact existing tracker matches can mutate `data/applications.md` automatically.
  Rationale: Existing project rules prohibit direct new row creation and require careful duplicate handling.
- Decision: Keep Gmail writes out of scope.
  Rationale: Tracking only needs read access; write scopes increase risk and review burden.

## Risks and Blockers

- Gmail skill access may not be available in non-Codex environments.
- Gmail search scope can miss messages; every run must report coverage.
- Parsing hiring emails is noisy; low-confidence signals must go to review queue.
- If hosted productization is required immediately, this plan must be superseded by an OAuth/backend plan.
- Google Gmail restricted scopes can require verification and, if restricted data is stored/transmitted server-side, security assessment.

## Productization Notes

If this becomes a product feature for external users, switch to first-party Gmail OAuth and design for:

- narrowest possible scopes,
- OAuth verification,
- restricted-scope security assessment if storing/transmitting Gmail data,
- encrypted refresh token storage,
- user data deletion,
- reconnect UX for revoked tokens,
- background sync workers,
- `users.watch` renewal,
- Pub/Sub acknowledgement/retry behavior,
- `history.list` fallback and full sync recovery.

Relevant primary sources:

- Gmail API scope guidance: https://developers.google.com/workspace/gmail/api/auth/scopes
- Gmail sync guidance: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail push notifications: https://developers.google.com/workspace/gmail/api/guides/push
- Gmail watch method: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
- Google API Services User Data Policy: https://developers.google.com/terms/api-services-user-data-policy
- Workspace API user data/developer policy: https://developers.google.com/gmail/api/policy

## Progress Log

- 2026-04-25: Read `CLAUDE.md`, `docs/exec-plans/README.md`, `TODOS.md`, existing Gmail tracker review plan, Gmail skill instructions, `package.json`, `followup-cadence.mjs`, `web/build-dashboard.mjs`, and tracker/dashboard references.
- 2026-04-25: Checked gstack `/plan-eng-review` preamble; repo mode is collaborative, branch is `main`.
- 2026-04-25: Confirmed no design doc exists for this branch.
- 2026-04-25: Checked recent git history; recent work heavily touches scan/dashboard workflows, so this plan recommends reusing dashboard/tracker paths rather than adding parallel UI/data stores.
- 2026-04-25: Reviewed current Gmail API docs for scopes, sync, push notifications, watch renewal, and user data policy.
- 2026-04-25: Wrote Stage 1 recommendation: use Gmail skill as read adapter for local MVP, make repo-owned derived signals durable, defer OAuth to productization.

## Final Outcome

Plan completed. Recommended path is Stage 1 Gmail skill-backed local import plus durable repo artifacts, with a clean adapter boundary for future first-party Gmail OAuth.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | - | - |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | - | - |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 22 test gaps identified for future implementation; 0 current critical gaps for planning |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | - | - |

**UNRESOLVED:** UI surface decision remains open: existing dashboard only vs separate product UI.
**VERDICT:** ENG PLAN REVIEW COMPLETE - ready to implement Stage 1 when requested.
