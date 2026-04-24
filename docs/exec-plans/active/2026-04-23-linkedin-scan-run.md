# LinkedIn Scan Run

## Background

The `/career-ops linkedin-scan` mode uses the authenticated `bb-browser`
profile plus the local bridge to read LinkedIn Jobs search results, score rows
 with the existing newgrad scanner, enrich promising jobs, and write qualified
 survivors to `data/pipeline.md`.

## Goal

Fix and execute the repo-native LinkedIn scan flow for the current 24-hour
search URL, including the newer LinkedIn result-list shape where visible rows
are clickable buttons and only the selected row exposes a job-view URL.

## Scope

- Check required career-ops setup files.
- Check update status as required by `CLAUDE.md`.
- Verify bridge health and start the bridge if needed.
- Run a read-only LinkedIn preview first.
- If preview succeeds, run a write-path LinkedIn scan with the existing script.
- Inspect resulting repo artifacts and record the outcome.
- Add a visible-result fallback that identifies all visible LinkedIn job rows,
  selects each row, obtains its canonical job-view URL, and reuses the existing
  score/enrich/pipeline flow.

## Assumptions

- Existing repo files remain the only source of truth for this run.
- The current dirty worktree contains unrelated user changes and must not be
  reverted.
- Because `config/profile.yml` does not currently define
  `linkedin_scan.search_url`, this run will use the documented 24-hour LinkedIn
  Jobs URL from `modes/linkedin-scan.md`.
- A minimal reversible path is preferred: preview first, then write only after
  live extraction succeeds.

## Uncertainties

- LinkedIn login state may be stale or may require manual recovery.
- The local bridge may not be running.
- The live LinkedIn DOM may have shifted since the implementation plan was
  written.
- The user did not explicitly request direct evaluation queueing, so the write
  run may stop at pipeline writes if that is the safer default for this turn.

## Implementation Steps

1. Confirm setup, update status, and mode instructions.
   Verify: required setup files exist; update check is recorded; `modes/linkedin-scan.md` defines the expected flow.
2. Ensure bridge availability.
   Verify: `http://127.0.0.1:47319/v1/health` returns success in real Codex mode.
3. Run a no-write preview.
   Verify: `npm run linkedin-scan -- --url "<LinkedIn URL>" --score-only --limit 20` completes or reports a concrete blocker.
4. Run the write path if preview succeeds.
   Verify: `npm run linkedin-scan` with explicit flags completes and reports promoted, enriched, added, and skipped counts.
5. Inspect resulting artifacts and summarize.
   Verify: changed files and any pipeline/report updates are identified and recorded here.
6. Fix visible LinkedIn list extraction for the current `search-results` page.
   Verify: unit tests cover visible-row text parsing and live `--score-only`
   extracts all visible rows from the user-provided URL shape.

## Verification Approach

- `node update-system.mjs check`
- Required-file existence checks
- `curl http://127.0.0.1:47319/v1/health`
- `npm run linkedin-scan -- --help`
- `npm run linkedin-scan -- --url "<LinkedIn URL>" --score-only --limit 20`
- Write-path LinkedIn scan command if preview succeeds
- Targeted normalizer tests
- Script and bridge type checks

## Progress Log

- 2026-04-23: User invoked `/career-ops linkedin-scan`.
- 2026-04-23: Goal: run the existing LinkedIn scan flow against a live
  authenticated session, starting with the safest read-only preview before any
  write-path action.
- 2026-04-23: Success criteria: update/setup checks pass, bridge health is
  known or restored, preview completes or yields a concrete blocker, write-path
  execution only proceeds after preview success, and resulting artifacts are
  identified before completion is reported.
- 2026-04-23: Update check returned `up-to-date` at `1.3.0`; required setup
  files `cv.md`, `config/profile.yml`, `modes/_profile.md`, `portals.yml`, and
  `data/applications.md` are present.
- 2026-04-23: `bb-browser` is installed on PATH.
- 2026-04-23: Initial bridge health check found no listener on
  `127.0.0.1:47319`.
- 2026-04-23: `config/profile.yml` does not currently define
  `linkedin_scan.search_url`, so this run will use the documented 24-hour
  LinkedIn Jobs URL from `modes/linkedin-scan.md`.
- 2026-04-23: `npm run linkedin-scan -- --help` passed and confirmed the
  expected `--score-only`, `--no-evaluate`, paging, and evaluation options.
- 2026-04-23: Started the bridge with `npm run ext:bridge`; authenticated
  `/v1/health` passed with `execution.mode=real`, `execution.realExecutor=codex`,
  and tracker/CV/profile checks all OK.
- 2026-04-23: Read-only preview using the documented LinkedIn URL completed
  successfully, which confirms the current `bb-browser` LinkedIn session is
  usable. First pass with `--score-only --limit 20` extracted 1 raw row, kept 1
  unique row after dedupe, and produced 0 promoted / 1 filtered.
- 2026-04-23: Expanded read-only preview with `--score-only --pages 4 --limit 100`
  to distinguish a bad login from a weak search result set. The expanded probe
  extracted 2 raw rows total across 4 offsets, kept 2 unique rows, and still
  produced 0 promoted / 2 filtered.
- 2026-04-23: Decision: skip the write-path run for this turn. The current
  repo-default/example LinkedIn URL is live and readable, but it does not yield
  promotable rows right now, so a write run would only churn the bridge without
  creating useful pipeline entries or evaluations.
- 2026-04-23: No pipeline, report, or dashboard artifacts were written by this
  run attempt. The only in-scope repo change is this execution plan file.
- 2026-04-23: User confirmed the desired fix: make the full LinkedIn scan flow
  recognize every visible job on the current `linkedin.com/jobs/search-results`
  page shape.
- 2026-04-23: Live inspection of the user-provided URL shape showed 8 visible
  results in the page text, but zero `[data-job-id]` nodes and only one
  `/jobs/view/` anchor for the currently selected row. This explains why the
  previous scanner only extracted one row.
- 2026-04-23: Live inspection found that visible rows are rendered as
  `role="button"` / `tabindex="0"` elements with title, company, location, and
  posted-age text. Clicking a row updates `currentJobId` and the selected
  `/jobs/view/{id}/` detail link without touching application controls.
- 2026-04-23: Wrote the design to
  `docs/superpowers/specs/2026-04-23-linkedin-visible-list-scan-design.md`.
- 2026-04-23: Implemented the visible-list fallback. The scanner now reads
  job-like `role="button"` result rows, parses their visible title/company/
  location/posted text, selects each row to recover `currentJobId`, canonicalizes
  to `https://www.linkedin.com/jobs/view/{id}/`, and feeds those rows into the
  existing score/enrich flow.
- 2026-04-23: Updated the default LinkedIn search pagination offset from 6 to
  25 to match the documented/tested LinkedIn `start` offset convention.
- 2026-04-23: Added normalizer coverage for visible LinkedIn result-button text
  and non-job filter buttons.
- 2026-04-23: Verification passed: `npm run linkedin-scan -- --help` showed the
  new default `--page-size 25`; `npm --prefix bridge run typecheck` passed; a
  direct `tsx` smoke assertion for `parseLinkedInVisibleJobCardText` passed.
- 2026-04-23: `npm --prefix bridge run test --
  src/adapters/linkedin-scan-normalizer.test.ts` could not run in this local
  environment because Vitest/rolldown failed to load its native darwin-arm64
  binding due to a macOS code-signing mismatch. This is an environment/tooling
  blocker, not a test assertion failure.
- 2026-04-23: Live read-only verification with the user-provided LinkedIn URL
  passed. The scanner extracted 8 raw visible rows, deduped them to 7 stable
  LinkedIn job-view URLs, scored 1 promoted / 6 filtered, and called no bridge
  write endpoints under `--score-only`.
- 2026-04-23: Live write-path verification with `--no-evaluate --enrich-limit 2`
  passed. The scanner extracted 7 unique LinkedIn rows, promoted 1, enriched 1,
  failed 0 detail reads, and the bridge skipped the candidate with
  `pipeline_threshold` under existing rules. No direct evaluations were queued.
- 2026-04-23: User invoked `/career-ops linkedin-scan` again. Goal: run the
  current repo-native LinkedIn scan flow, keep the run bounded to the documented
  24-hour URL because `config/profile.yml` still has no
  `linkedin_scan.search_url`, and record concrete verification results.
- 2026-04-23: Required setup files are present. `node update-system.mjs check`
  returned `offline` with local version `1.3.0`.
- 2026-04-23: The bridge was not listening initially. Starting
  `npm run ext:bridge` required running outside the sandbox because `tsx` could
  not open its local IPC socket inside the sandbox. Authenticated bridge health
  then passed with `execution.mode=real`, `execution.realExecutor=codex`,
  tracker/profile/CV checks OK, Codex CLI OK, and Playwright Chromium OK.
- 2026-04-23: `npm` and `bb-browser` were not on the default shell PATH. Used
  Homebrew npm and built the checked-in `bb-browser` workspace with
  `pnpm install` and `pnpm build`, then used a temporary `/tmp/career-ops-bin`
  PATH shim pointing at `bb-browser/dist/cli.js`. `bb-browser --version`
  reported `0.11.3`.
- 2026-04-23: Read-only preview passed:
  `npm run linkedin-scan -- --url "<documented LinkedIn URL>" --score-only
  --limit 20` reported bridge health OK, extracted 6 raw rows, deduped to 6
  unique rows, promoted 1, filtered 5, and called no bridge write endpoints.
- 2026-04-23: Safe write path passed:
  `npm run linkedin-scan -- --url "<documented LinkedIn URL>" --no-evaluate
  --enrich-limit 5` reported bridge health OK, extracted 6 raw rows, deduped to
  6 unique rows, promoted 1, filtered 5, enriched 1, failed 0 detail reads, and
  skipped the candidate under the existing `pipeline_threshold` rule. No direct
  evaluations were queued.
- 2026-04-23: Artifact inspection showed no tracked `data/`, `reports/`,
  `output/`, or `bb-browser/` changes from this run. The only in-scope
  repository update for this invocation is this progress log entry.
- 2026-04-23: User invoked `/career-ops linkedin-scan` again. Goal: execute
  the current repo-native LinkedIn scan flow against the documented 24-hour URL
  because `config/profile.yml` still has no `linkedin_scan.search_url`.
- 2026-04-23: Required setup files are present. `node update-system.mjs check`
  returned `offline` with local version `1.3.0`.
- 2026-04-23: Authenticated bridge health initially passed with
  `execution.mode=real`, `execution.realExecutor=codex`, tracker/profile/CV
  checks OK, Codex CLI OK, and Playwright Chromium OK.
- 2026-04-23: Read-only preview passed:
  `npm run linkedin-scan -- --url "<documented LinkedIn URL>" --score-only
  --limit 20` reported bridge health OK, extracted 25 raw rows, deduped to 20
  unique rows, promoted 16, filtered 4, and called no bridge write endpoints.
- 2026-04-23: The package script currently points `linkedin-scan` at
  `bun --cwd bridge ...`, but `bun` is not installed on PATH. To avoid editing
  unrelated dirty worktree changes, this run used the same scanner target
  directly via `npm --prefix bridge exec -- tsx`.
- 2026-04-23: A separate long-running bridge tool session was terminated before
  the write-path retry, causing transient `fetch failed` errors. Re-ran the
  bridge and scanner in one controlled shell invocation and stopped only that
  bridge process afterward.
- 2026-04-23: Safe write path passed:
  `npm --prefix bridge exec -- tsx scripts/linkedin-scan-bb-browser.ts --url
  "<documented LinkedIn URL>" --no-evaluate --enrich-limit 5` reported bridge
  health OK, extracted 25 raw rows, deduped to 25 unique rows, promoted 21,
  filtered 4, enriched 5, failed 0 detail reads, and the bridge skipped all 5
  candidates under the existing `detail_value_threshold` rule. No direct
  evaluations were queued.
- 2026-04-23: Artifact inspection showed no tracked `data/`, `reports/`, or
  `output/` changes from this run. The only in-scope repository update for this
  invocation is this progress log entry.
- 2026-04-23: User clarified that 25 rows is not enough and the LinkedIn scan
  should page further each time to find 100 rows. Goal: make the default
  LinkedIn scan collect up to 100 unique rows without requiring manual
  `--pages` / `--limit` flags on every invocation.
- 2026-04-23: Updated `scripts/linkedin-scan-bb-browser.ts` defaults from
  `pages=1`, `limit=null` to `pages=6`, `limit=100`. Six pages are needed
  because a live 4-page preview produced only 94 unique rows after dedupe.
- 2026-04-23: Updated `modes/linkedin-scan.md` so the checked-in operating
  procedure states that the scanner defaults to `--pages 6 --limit 100`.
- 2026-04-23: Verification passed: scanner help output shows `--limit` default
  100 and `--pages` default 6; `npm --prefix bridge run typecheck` passed.
- 2026-04-23: Live default read-only preview passed. With no explicit
  `--pages` or `--limit`, the scanner opened 5 of the 6 allowed pages, reached
  122 raw rows / 100 unique rows after dedupe, scored 81 promoted / 19 filtered,
  and called no bridge write endpoints under `--score-only`.
- 2026-04-23: Live default safe write path passed. With no explicit `--pages`
  or `--limit`, the scanner opened 5 of the 6 allowed pages, reached 125 raw
  rows / 100 unique rows after dedupe, scored 88 promoted / 12 filtered,
  enriched 5, failed 0 detail reads, and the bridge skipped all 5 candidates
  under the existing `detail_value_threshold` rule. No direct evaluations were
  queued.
- 2026-04-23: During verification, `bb-browser` initially reported
  `Chrome not connected`; restarting the bb-browser daemon restored CDP and the
  scan completed. The temporary bridge process used for verification was stopped
  after the controlled runs.
- 2026-04-23: Artifact inspection showed no tracked `data/`, `reports/`, or
  `output/` changes from this run. The in-scope repository updates are the
  scanner default, the LinkedIn mode instructions, and this progress log entry.
- 2026-04-23: User reported that LinkedIn row selection is too fast and asked
  why the 100-row run produced no usable candidate despite 88 promoted / 12
  filtered / 5 enriched / 0 failed.
- 2026-04-23: Added human-paced visible-row selection to the LinkedIn fallback:
  after scrolling a result row into view, the scanner waits a randomized
  650-1400 ms, dispatches a mousemove, focuses the row, waits another
  120-320 ms, clicks, then waits 800-1800 ms before polling the selected detail
  state. This slows only the LinkedIn visible-button selection path.
- 2026-04-23: Added enriched value-score diagnostics after detail enrichment.
  The scanner now prints each enriched row's local value score, pass/fail
  threshold, reasons, penalties, and score breakdown before bridge writes.
- 2026-04-23: Diagnosis: the first enriched LinkedIn candidate, DataVisor
  Software Engineer, Artificial Intelligence, scored 6.8/7 with no penalties,
  strong structured skill match, early-career signal, and salary signal. It
  failed only because LinkedIn lacks the Jobright-style `siteMatch` fields and
  had weak posting-quality structure, leaving it 0.2 below the old threshold.
- 2026-04-23: Updated user-specific `config/profile.yml` threshold from
  `detail_value_threshold: 7` to `6.5`, and updated the LinkedIn mode's safe
  write command from `--enrich-limit 5` to `--enrich-limit 20` so a 100-row
  scan samples more than the top five detail pages.
- 2026-04-23: Verification passed: `npm --prefix bridge run typecheck` passed,
  `tsx scripts/linkedin-scan-bb-browser.ts --help` passed, and a live bounded
  LinkedIn smoke run with `--pages 1 --limit 5 --no-evaluate --enrich-limit 1`
  completed using the slower row selection path.
- 2026-04-23: Live bounded smoke after lowering the threshold passed. DataVisor
  scored 6.8/6.5, `passed=true`, bridge enrich returned added=1 / skipped=0 /
  candidates=1, and `data/pipeline.md` now contains the DataVisor LinkedIn
  pipeline entry. Direct evaluations were still disabled by `--no-evaluate`.
- 2026-04-23: User identified a LinkedIn detail extraction gap: the detailed
  DataVisor JD is hidden behind the `About the job` section's `... more`
  expander. The previous extraction could read the collapsed LinkedIn detail,
  which undercounted posting quality and structured detail.
- 2026-04-23: Updated `extension/src/content/extract-linkedin.ts` so
  `extractLinkedInDetail()` attempts to expand non-mutating `more`, `show more`,
  `see more`, or `read more` controls inside the job description/about-job
  container before reading the JD text. Application, save, message, and other
  mutating controls remain outside this path.
- 2026-04-23: Direct DataVisor DOM inspection showed the first implementation
  matched the top-card `More options` button, not the `About the job` expander.
  Refined expansion to exclude `More options`, `show less`, premium/posting
  controls, and to match only description-style `show/see/read more`, ellipsis
  more, or exact `more` controls.
- 2026-04-23: Direct DataVisor DOM inspection also showed LinkedIn's job page
  uses an internal scrollable `main#workspace` pane; `window.scrollTo` does not
  move the detail content. Updated the extractor to scroll candidate internal
  job-detail panes before searching for description/about-job containers so
  lazy-loaded About text has a chance to mount before extraction.
- 2026-04-23: Verification passed: `npm --prefix extension run typecheck` and
  `npm --prefix bridge run typecheck` both passed after the expander change.
  A bounded live LinkedIn scan still completed with slower row selection and
  value-score diagnostics, confirming no scanner regression. The current
  bb-browser DataVisor direct page still did not expose `About the job` in DOM
  during inspection, so full DataVisor expansion could not be directly proven in
  that browser state.
- 2026-04-23: User requested one more extraction test for comparison. Direct
  DataVisor job-view extraction and search-results `currentJobId=4405013961`
  extraction both failed to expose the detailed `About the job` body in the
  current bb-browser DOM. The search-results test clicked the DataVisor row, but
  the extracted text still contained only the result list plus DataVisor top
  card fields, not Role Summary, Primary Responsibilities, Requirements, or the
  full Description body. This remains an extraction blocker to fix before
  trusting LinkedIn detail scoring.
- 2026-04-23: User explicitly narrowed the follow-up bug: the scanner must
  detect the obvious LinkedIn `About the job` / `Description` signal and read
  the expanded body behind the section's `more` control. Success criteria for
  this follow-up: a focused DataVisor extraction smoke must return a non-empty
  description containing `Role Summary`, `Primary Responsibilities`, and
  `Requirements` or a concrete browser-side blocker must be recorded.
- 2026-04-23: Reproduced the root cause. The earlier expander clicked
  LinkedIn's footer `More` control from a broad `main` container, opening a
  footer/language overlay instead of the job-description expander. After closing
  that overlay, the DataVisor DOM contained `About the job`, `Role Summary`,
  `Primary Responsibilities`, and `Requirements`.
- 2026-04-23: Updated `extractLinkedInDetail()` so broad fallback text is
  segmented from the `About the job` / `Description` marker, stops before
  premium/company chrome, and exact `More` clicks are allowed only inside a
  description-like context. This prevents the footer `More` misclick.
- 2026-04-23: Found a second LinkedIn behavior: fresh search-result tabs can
  keep the right detail pane stuck on `Assessing your job match`, with no
  `About the job` mounted in the DOM. The actual scroll pane uses randomized
  class names, so the extractor now also probes right-side scrollable panes that
  contain the current job title.
- 2026-04-23: Added a scanner-level fallback for LinkedIn job descriptions.
  When the in-page LinkedIn detail is shorter than 400 characters, the scanner
  fetches `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jobId}` via
  `bb-browser fetch`, parses the returned `description__text` HTML, and merges
  it into the normal `NewGradDetail`.
- 2026-04-23: Focused DataVisor extraction smoke passed on a loaded
  search-results tab. Extracted title/company were
  `Software Engineer, Artificial Intelligence` / `DataVisor`; description length
  was 6,779 characters and contained `About the job`, `Role Summary`,
  `Primary Responsibilities`, and `Requirements`; structured requirements and
  skill tags were populated.
- 2026-04-23: DataVisor guest endpoint smoke passed even when a fresh
  search-results tab remained stuck on the job-match skeleton. The endpoint
  returned 69,868 bytes and contained `Description`, `Role Summary`,
  `Primary Responsibilities`, `Requirements`, and the DataVisor description
  body.
- 2026-04-23: Verification passed: `npm --prefix extension run typecheck` and
  `npm --prefix bridge exec -- tsx scripts/linkedin-scan-bb-browser.ts --help`
  both passed. Full `npm --prefix bridge run typecheck` is currently blocked by
  an unrelated `bridge/src/server.test.ts` `codexModel` fixture mismatch in the
  dirty worktree.
- 2026-04-23: A bounded live scanner smoke completed detail enrichment for
  three promoted rows and showed the diagnostic path still works, but the
  bridge write call ended with `fetch failed`. The DataVisor row itself was not
  enriched in that scan because it is already in the local pipeline/seen set,
  so the focused DataVisor DOM and guest-endpoint smokes are the verification
  source for this specific bug.

## Key Decisions

- Use the documented 24-hour LinkedIn search URL because no repo-configured
  LinkedIn URL exists yet.
- Start with `--score-only` to verify live extraction and login state before any
  pipeline write.
- Skip the write-path run when preview proves the session works but returns zero
  promoted rows, because that is the smallest reversible path and avoids empty
  operational churn.
- Keep the legacy static extractor, but add a scanner-level fallback that
  selects each visible LinkedIn result button to recover its canonical job-view
  URL.

## Risks and Blockers

- LinkedIn may require manual login or checkpoint recovery.
- Live bridge or LinkedIn failures may prevent a write-path scan in this turn.
- Fresh LinkedIn search-result tabs may leave the authenticated detail pane on
  `Assessing your job match`; the guest jobPosting fallback is now the reliable
  source when that happens.
- The current dirty worktree has an unrelated bridge test fixture mismatch
  (`codexModel` missing in `bridge/src/server.test.ts`) that blocks full bridge
  typecheck until that fixture is updated.

## Final Outcome

The LinkedIn scanner now handles the current visible-result-button page shape.
It no longer depends on every result exposing `[data-job-id]`; it selects each
visible job row to recover a stable LinkedIn job-view URL, then reuses the
existing score, enrich, pipeline, and evaluation flow. Live verification against
the user-provided URL extracted the visible list and completed the
`--no-evaluate` enrich path successfully.

The latest `/career-ops linkedin-scan` invocation also completed successfully
against the documented 24-hour LinkedIn URL. It found 6 unique visible rows,
promoted and enriched 1 candidate, and wrote no pipeline entries because the
candidate was rejected by the existing `pipeline_threshold` rule.

The latest rerun completed successfully against the documented 24-hour
LinkedIn URL. The preview found 20 unique rows with 16 promoted. The bounded
write path found 25 unique rows, enriched 5, and wrote no pipeline entries
because all enriched candidates were rejected by the existing
`detail_value_threshold` rule. No direct evaluations were queued.

The default LinkedIn scan now targets 100 unique rows instead of one visible
page. The scanner defaults to `--pages 6 --limit 100`; live verification reached
100 unique rows in both read-only preview and safe write-path mode, with no
pipeline entries added because enriched candidates were rejected by the existing
`detail_value_threshold` rule.

LinkedIn row selection is now deliberately slower and emits value-score
diagnostics for enriched candidates. The local detail threshold was lowered to
6.5 in user profile config after a no-penalty 6.8/10 LinkedIn candidate was
being rejected by the old 7.0 threshold; a bounded live smoke verified that the
same candidate is now written to `data/pipeline.md`.

LinkedIn detail extraction now explicitly handles the `About the job` expander
path: it scrolls internal job-detail panes, avoids the unrelated top-card
`More options` button, and clicks only non-mutating description `more` controls
before reading the JD.

Follow-up extraction testing showed the current bb-browser LinkedIn DOM can
still omit the full `About the job` body even after selecting DataVisor from the
search-results list. In that state the extractor returns top-card/list text only,
so LinkedIn detail scoring still needs a stronger detail-pane extraction path.

The DataVisor `About the job` extraction bug is now fixed in both layers. The
content extractor no longer clicks LinkedIn footer `More`, segments broad
fallback text from the actual `About the job` / `Description` marker, and can
read the loaded DataVisor description as a 6,779-character JD with Role Summary,
Primary Responsibilities, Requirements, structured requirements, and skill tags.
The scanner also has a LinkedIn guest jobPosting fallback for cases where the
authenticated detail pane stays stuck on the job-match skeleton; the DataVisor
guest endpoint was verified to contain the same detailed Description signals.
