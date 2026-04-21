# LinkedIn Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/career-ops linkedin-scan` for LinkedIn Jobs discovery through `bb-browser`, reusing the existing newgrad scanner bridge, scoring, pipeline, and evaluation flow.

**Architecture:** Keep durable scanner logic in this repository. Use `bb-browser` only as the logged-in browser transport for LinkedIn, then normalize LinkedIn list/detail data into the existing `NewGradRow` and `NewGradDetail` contracts.

**Tech Stack:** TypeScript, Node.js, `bb-browser` CLI, Fastify bridge endpoints, existing `newgrad-scan` contracts, Vitest, Markdown mode files.

---

## Background

The user wants to use the bundled `bb-browser` project to search LinkedIn Jobs
with this 24-hour search URL:

```text
https://www.linkedin.com/jobs/search-results/?currentJobId=4347121472&keywords=software%20ai%20engineer%20new%20graduate%20job%20posted%20in%20the%20past%2024%20hours&origin=JOB_SEARCH_PAGE_JOB_FILTER&referralSearchId=AGHvJSQGboSyT24DsI0dwg%3D%3D&f_TPR=r86400
```

The existing `newgrad-scan` path already solves most downstream work:

```text
source list rows
  -> /v1/newgrad-scan/score
  -> detail enrichment
  -> /v1/newgrad-scan/enrich
  -> pipeline/history/direct evaluation
```

Live `bb-browser` inspection on 2026-04-21 confirmed:

- The `bb-browser` profile is logged into LinkedIn after the user authenticated.
- Existing community adapters are `linkedin/profile` and `linkedin/search`; they
  do not cover LinkedIn Jobs search.
- LinkedIn Jobs result cards expose `data-job-id`.
- The detail pane exposes title, company, location/posted metadata, full JD text,
  and Apply buttons.

## Goal

Implement a source-specific `/career-ops linkedin-scan` mode that:

1. Opens or reads a LinkedIn Jobs search URL through `bb-browser`.
2. Extracts visible job rows without clicking mutating LinkedIn controls.
3. Scores and deduplicates rows through the existing bridge.
4. Enriches promoted LinkedIn job detail pages.
5. Writes qualifying rows as `linkedin-scan` pipeline/history entries.
6. Optionally queues direct evaluations using the existing `newgrad_quick` path.

## Scope

In scope:

- Add a LinkedIn DOM extractor file.
- Add a `bb-browser` autonomous scanner script.
- Add `linkedin-scan` source tag support to existing bridge adapters.
- Add targeted unit tests for source mapping, URL selection, pending parsing, and
  LinkedIn text normalization.
- Add `/career-ops linkedin-scan` router and mode documentation.
- Add concise discoverability docs and npm script alias.

Out of scope:

- Applying, Easy Apply, saving jobs, dismissing jobs, messaging recruiters, or
  clicking Apply to discover external URLs.
- A public LinkedIn API client.
- A private `~/.bb-browser` adapter as the durable implementation.
- Pagination beyond visible/infinite-scroll first-page collection in the first
  version.
- Replacing `newgrad-scan` or `builtin-scan`.

## Assumptions

- `bb-browser` is installed and available on `PATH`.
- The user can log into LinkedIn manually in the `bb-browser` managed browser.
- The bridge server is running before the scanner posts rows.
- `linkedin-scan` can reuse `config/profile.yml -> newgrad_scan` scoring for the
  first version.
- If no `--url` is passed, the script reads `config/profile.yml ->
  linkedin_scan.search_url`; if neither exists, it fails with a clear message.

## Uncertainties

- LinkedIn may change DOM shape or card class names; selectors must use semantic
  anchors and tests must cover pure normalization helpers.
- Some LinkedIn result rows are promoted or related results, not exact matches.
  Existing scoring should filter them.
- The Apply button often hides external ATS URLs behind a click. The first
  version should keep LinkedIn job-view URLs as pipeline URLs rather than
  clicking Apply.

## Simplest Viable Path

Build one source adapter over `bb-browser`, map it into existing scanner
contracts, and add only the bridge/source plumbing needed for a new
`linkedin-scan` tag.

```text
bb-browser tab
  |
  | eval extractLinkedInList()
  v
NewGradRow[]
  |
  | existing score endpoint
  v
ScoredRow[]
  |
  | open LinkedIn job detail URLs with bb-browser
  v
EnrichedRow[]
  |
  | existing enrich endpoint
  v
PipelineEntry[] tagged linkedin-scan
```

## What Already Exists

- `modes/newgrad-scan.md`: scanner workflow to imitate.
- `scripts/newgrad-scan-autonomous.ts`: autonomous scan/evaluate runner pattern.
- `extension/src/content/extract-newgrad.ts`: self-contained DOM extractor
  pattern.
- `extension/src/content/extract-builtin.ts`: source adapter that maps another
  job board into `NewGradRow` / `NewGradDetail`.
- `bridge/src/adapters/newgrad-scorer.ts`: scoring and hard filters.
- `bridge/src/adapters/newgrad-scan-history.ts`: history persistence.
- `bridge/src/adapters/newgrad-pending.ts`: pending pipeline parser.
- `bridge/src/adapters/newgrad-source.ts`: source-to-pipeline-tag mapping.
- `bridge/src/adapters/newgrad-links.ts`: URL choice for pipeline entries.

## NOT In Scope

- LinkedIn profile/post search: existing bb-browser adapters already cover that.
- LinkedIn account automation: login, checkpoint, CAPTCHA, and 2FA stay manual.
- Apply URL probing by clicking Apply: this could change application state and is
  excluded.
- Extension UI support: useful later, but the first path should use the
  authenticated `bb-browser` profile already confirmed by the user.

## Implementation Steps

1. [x] Create `extension/src/content/extract-linkedin.ts`.
   Verify: the file exports self-contained `extractLinkedInList` and
   `extractLinkedInDetail` functions that can be stringified and executed in a
   browser tab.

2. [x] Add pure LinkedIn normalization helpers under `bridge/src/adapters/`.
   Verify: tests cover job id extraction, job-view URL canonicalization,
   reposted-age normalization, work-model parsing, and login/checkpoint
   detection text.

3. [x] Extend source tag plumbing for `linkedin-scan`.
   Verify: `bridge/src/adapters/newgrad-source.ts`,
   `newgrad-scan-history.ts`, and `newgrad-pending.ts` accept
   `linkedin-scan`; tests prove existing `newgrad-scan` and `builtin-scan`
   behavior is unchanged.

4. [x] Harden pipeline URL selection for LinkedIn job views.
   Verify: `newgrad-links.test.ts` proves `https://www.linkedin.com/jobs/view/{id}/`
   is accepted as a job URL fallback, while LinkedIn company/profile/social URLs
   remain noise.

5. [x] Add `scripts/linkedin-scan-bb-browser.ts`.
   Verify: `--help` documents `--url`, `--score-only`, `--no-evaluate`,
   `--limit`, `--enrich-limit`, bridge host/port, and login recovery; the script
   exits cleanly before writes in `--score-only`.

6. [x] Add npm and mode routing.
   Verify: `package.json` has `linkedin-scan`; `.claude/skills/career-ops/SKILL.md`
   routes `linkedin-scan` / `linkedin`; discovery lists the command; shared
   context loading includes the mode.

7. [x] Add `modes/linkedin-scan.md`.
   Verify: mode docs include bridge check, LinkedIn login check, the supplied
   search URL shape, safe read-only boundaries, useful options, and result
   reporting.

8. [x] Update concise navigation docs.
   Verify: `CLAUDE.md`, `docs/CODEX.md`, and optional OpenCode command docs mention
   the new mode without expanding top-level files into long references.

9. [x] Run targeted verification.
   Verify:
   - `npm --prefix bridge run test -- src/adapters/newgrad-source.test.ts src/adapters/newgrad-links.test.ts src/adapters/newgrad-pending.test.ts src/adapters/newgrad-scan-history.test.ts src/adapters/linkedin-scan-normalizer.test.ts`
   - `npm --prefix bridge run typecheck`
   - `npm run linkedin-scan -- --url "<LinkedIn URL>" --score-only --limit 5`
   - `npm run linkedin-scan -- --url "<LinkedIn URL>" --no-evaluate --enrich-limit 2`
   - `npm run verify`

## Test Coverage Diagram

```text
CODE PATH COVERAGE
==================
[+] extract-linkedin.ts
    |
    +-- [GAP] login/checkpoint detection -> unit helper + live score-only check
    +-- [GAP] result card extraction -> live bb-browser score-only check
    +-- [GAP] detail pane extraction -> live no-evaluate enrich check
    +-- [GAP] Apply buttons are not clicked -> script test/inspection requirement

[+] newgrad-source.ts
    |
    +-- [GAP] linkedin.com -> linkedin-scan
    +-- [GAP] existing Built In and newgrad mappings unchanged

[+] newgrad-scan-history.ts
    |
    +-- [GAP] history rows persist portal=linkedin-scan
    +-- [GAP] seen-key dedupe handles LinkedIn job-view URLs

[+] newgrad-pending.ts
    |
    +-- [GAP] rich pipeline rows with (via linkedin-scan, score: ...)
    +-- [GAP] pending entries expose source=linkedin.com

[+] newgrad-links.ts
    |
    +-- [GAP] linkedin jobs/view URL accepted as fallback
    +-- [GAP] linkedin company/profile URLs ignored as noise

[+] linkedin-scan-bb-browser.ts
    |
    +-- [GAP] missing bb-browser -> clear setup error
    +-- [GAP] LinkedIn login redirect -> clear login recovery
    +-- [GAP] --score-only does not write files
    +-- [GAP] --no-evaluate writes pipeline/history but queues no evaluation
```

```text
USER FLOW COVERAGE
==================
/career-ops linkedin-scan
    |
    +-- [GAP] bridge offline -> tell user to start bridge
    +-- [GAP] LinkedIn not logged in -> tell user to run bb-browser open login URL
    +-- [GAP] logged in + score-only -> rows extracted and scored
    +-- [GAP] logged in + no-evaluate -> detail pages enriched and pipeline updated
    +-- [GAP] default path -> direct evaluations queued for enrich survivors
```

Current planned coverage: 0/20 paths tested because this is a pre-implementation
plan. All gaps above are required implementation verification items.

## Verification Approach

- Prefer focused bridge tests for deterministic source, URL, parser, and
  normalization behavior.
- Use `bb-browser` only for live LinkedIn integration checks that require login.
- Use `--score-only` before any write path.
- For write-path verification, use `--no-evaluate --enrich-limit 2` first so the
  scanner can prove pipeline/history writes without queueing applications or
  formal evaluations.
- Run `npm run verify` last to catch tracker and report integrity regressions.

## Key Decisions

- Use `bb-browser` as the primary LinkedIn transport because the user's
  authenticated LinkedIn state is already there.
- Keep extractor logic in the repo, not in `~/.bb-browser/sites`, because the repo
  is the durable system of record.
- Reuse `newgrad_scan` scoring rather than inventing `linkedin_scan` scoring for
  the first version.
- Use LinkedIn job-view URLs as pipeline URLs when external ATS URLs are hidden
  behind Apply buttons.
- Do not click Apply, Save, Dismiss, or message controls.

## Risks And Blockers

- LinkedIn can change DOM structure. Mitigation: anchor on `data-job-id`,
  `/jobs/view/`, headings, and visible text rather than generated classes.
- LinkedIn can show login, checkpoint, or account-verification pages. Mitigation:
  detect those states and stop with manual recovery instructions.
- The current worktree has many unrelated uncommitted changes. Mitigation: keep
  implementation edits surgical and do not revert existing work.
- The `bb-browser` CLI is an external local dependency. Mitigation: check
  availability before running and fail clearly if absent.

## Failure Modes

| Codepath | Production failure | Test/error handling requirement | User-visible result |
|----------|--------------------|---------------------------------|---------------------|
| `bb-browser open/eval` | CLI missing or daemon unavailable | Script checks `bb-browser --version` before scan | Clear setup error |
| LinkedIn auth | Login redirect or checkpoint | Detect login/checkpoint text/title/URL | Manual login instruction |
| List extraction | No cards due DOM change | Score-only live check and zero-row diagnostic | Page title/URL in error |
| Detail extraction | Some job detail pages fail | Continue per-row, count failures | Summary with failed count |
| Source tagging | LinkedIn rows parsed as newgrad | Unit tests for `linkedin-scan` mapping | Prevented by tests |
| URL selection | Company homepage chosen over job view | Unit tests for LinkedIn job-view fallback | Prevented by tests |
| Apply safety | Scanner clicks mutating Apply button | Code review and integration inspection | Must never happen |

No planned failure mode should be silent; all have either a test or an explicit
error path.

## Progress Log

- 2026-04-21: Read project rules, existing `newgrad-scan`, `builtin-scan`,
  bridge adapters, extension extractors, and `bb-browser` docs.
- 2026-04-21: Confirmed `bb-browser` 0.11.3 is installed.
- 2026-04-21: Confirmed community LinkedIn adapters are profile/post search only,
  not Jobs search.
- 2026-04-21: Confirmed the user's `bb-browser` profile can access LinkedIn after
  login.
- 2026-04-21: Inspected the supplied LinkedIn Jobs page with `bb-browser` and
  captured stable first-version DOM anchors.
- 2026-04-21: Wrote this plan before implementation.
- 2026-04-21: Ran plan self-review and engineering review. Complexity is above
  the nominal 8-file smell threshold, but reducing scope would create parallel
  scanner logic or leave source tags untested. Scope remains accepted as the
  smallest complete repo-integrated path.
- 2026-04-21: Began implementation on `codex/linkedin-scan` because the current
  workspace had prerequisite uncommitted scanner work that a clean worktree would
  not contain.
- 2026-04-21: Added self-contained LinkedIn list/detail DOM extractors and
  verified `npm --prefix extension run typecheck`.
- 2026-04-21: Added LinkedIn normalizer helpers and verified
  `npm --prefix bridge run test -- src/adapters/linkedin-scan-normalizer.test.ts`.
- 2026-04-21: Added `linkedin-scan` source tag plumbing, pending/history parser
  support, and LinkedIn job-view URL selection.
- 2026-04-21: Verified shared source/link/pending/history coverage with
  `npm --prefix bridge run test -- src/adapters/newgrad-source.test.ts src/adapters/newgrad-links.test.ts src/adapters/newgrad-pending.test.ts src/adapters/newgrad-scan-history.test.ts src/adapters/linkedin-scan-normalizer.test.ts`.
- 2026-04-21: Added `scripts/linkedin-scan-bb-browser.ts`, `npm run
  linkedin-scan`, `/career-ops linkedin-scan` routing, mode docs, Codex docs,
  and OpenCode command discoverability.
- 2026-04-21: Verified `npm run linkedin-scan -- --help` after rerunning outside
  the sandbox because `tsx` needed a local IPC pipe.
- 2026-04-21: Live `--score-only --limit 5` smoke succeeded against the supplied
  LinkedIn URL with 5 rows extracted and 2 promoted, and no bridge write
  endpoints called.
- 2026-04-21: Live `--no-evaluate --enrich-limit 2` smoke succeeded against the
  supplied LinkedIn URL with 6 rows extracted, 2 detail pages enriched, and no
  evaluation jobs queued; the bridge skipped both rows at
  `detail_value_threshold`, so no live pipeline entry was added.
- 2026-04-21: Added a bridge adapter regression test proving a passing LinkedIn
  enriched row writes a `linkedin-scan` pipeline entry.
- 2026-04-21: Final verification passed: focused bridge tests, bridge
  typecheck, extension typecheck, script-level `tsc --noEmit`, live score-only
  smoke, live no-evaluate enrichment smoke, and `npm run verify`.

## Plan Eng Review

### Step 0: Scope Challenge

Existing code already solves the downstream scanner work:

- `newgrad-scan` provides scoring, enrichment, pipeline writes, history writes,
  and direct evaluation.
- `builtin-scan` provides the precedent for mapping another job source into
  `NewGradRow` and `NewGradDetail`.
- `bb-browser` provides the authenticated LinkedIn browser transport.

The minimum complete implementation is still cross-cutting because a new source
must be recognized by extraction, source tagging, URL selection, pending parsing,
mode routing, docs, and tests. A smaller `bb-browser`-only adapter would be
shorter but would violate the repository-as-source-of-record rule and create a
parallel pipeline.

Search check:

- [Layer 1] Reuse browser DOM extraction and existing bridge endpoints already in
  this repo.
- [Layer 1] Use `bb-browser` as documented: open/eval/fetch against the user's
  real browser login state.
- [Layer 3] Do not click LinkedIn Apply to discover external URLs; preserving
  read-only behavior is more important than extracting every ATS link.

TODOS cross-reference:

- `TODOS.md` has no item blocking this plan.
- No deferred item should be bundled into this work.

Distribution check:

- No new external artifact type is introduced. The scanner is exposed through
  existing npm scripts and `/career-ops` mode routing.

### Architecture Review

No blocking architecture issue found. The plan reuses existing boundaries:

```text
bb-browser transport -> source extractor -> existing bridge scorer/enricher -> pipeline/eval
```

Realistic failure scenario: LinkedIn redirects to login or checkpoint. The plan
accounts for this with explicit login/checkpoint detection before scoring.

Realistic failure scenario: LinkedIn changes result card classes. The plan avoids
generated classes and anchors on `data-job-id`, `/jobs/view/`, headings, and
visible text semantics.

### Code Quality Review

No blocking code-quality issue found. The main DRY risk is duplicating
`newgrad-scan-autonomous.ts`; the plan keeps the LinkedIn runner source-specific
while reusing the same bridge endpoints and contracts. During implementation,
shared helpers should only be extracted if duplication becomes concrete across
the two autonomous scripts.

### Test Review

Coverage diagram is included above. The plan currently identifies 20 required
test/verification paths because no implementation exists yet. This is acceptable
for plan stage; implementation must not be declared complete until those gaps are
closed or explicitly removed from scope.

Test plan artifact:

```text
~/.gstack/projects/Jaydccq-career-ops/hongxichen-main-eng-review-test-plan-20260421-175927.md
```

No prompt/LLM template changes are planned, so no eval suite is required beyond
the existing direct-evaluation smoke path.

### Performance Review

No blocking performance issue found. The plan limits LinkedIn detail enrichment
with `--limit`, `--enrich-limit`, and existing batch-style throttling. Pagination
is intentionally out of scope for the first version to avoid aggressive LinkedIn
traffic and larger blast radius.

### Review Completion Summary

- Step 0: Scope Challenge — scope accepted as-is; complexity smell noted but
  reduction would create weaker parallel logic.
- Architecture Review: 0 blocking issues found.
- Code Quality Review: 0 blocking issues found.
- Test Review: diagram produced, 20 planned verification gaps identified.
- Performance Review: 0 blocking issues found.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 0 items proposed.
- Failure modes: 0 critical silent gaps flagged.
- Outside voice: skipped.
- Lake Score: 1/1 recommendation chose the complete option.

## Final Outcome

Implemented. `/career-ops linkedin-scan` now routes to `modes/linkedin-scan.md`,
`npm run linkedin-scan` runs the `bb-browser` LinkedIn Jobs scanner, LinkedIn
rows flow through the existing newgrad scorer/enricher as `linkedin-scan`, and
targeted tests cover source tags, pending/history parsing, URL selection,
normalization, and pipeline writes for passing LinkedIn rows.

Live verification against the supplied LinkedIn URL succeeded for score-only
list extraction/scoring and bounded no-evaluate detail enrichment. The live
LinkedIn rows observed during the no-evaluate smoke did not pass the existing
`detail_value_threshold`, so that run wrote no pipeline entry; a deterministic
bridge regression test proves pipeline writes for LinkedIn rows that do pass.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | - | - |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | - | - |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | clean | 0 blocking issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | - | - |

**VERDICT:** ENG CLEARED - ready to implement the plan.
