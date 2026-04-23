# Newgrad Scan Run

## Background

The `/career-ops newgrad-scan` mode uses the Chrome extension and local bridge to extract listings from `newgrad-jobs.com`, score them with `config/profile.yml -> newgrad_scan`, enrich strong matches, and write survivors to `data/pipeline.md`.

## Goal

Make `/career-ops newgrad-scan` actionable without requiring the user to manually drive Chrome: open the source page, scan, enrich, and write qualifying results through the existing bridge pipeline.

## Scope

- Check required career-ops setup files.
- Check the update status as required by `CLAUDE.md`.
- Verify whether the local bridge is reachable.
- Start the bridge if it is not running.
- Refresh the extension build if needed.
- Add an autonomous browser-driven scan path that reuses the existing content extractors and bridge endpoints.
- Run the autonomous scan once.

## Assumptions

- The current dirty worktree contains user or prior-session changes and must not be reverted.
- The existing `extension/src/content/extract-newgrad.ts` extractor functions are the source of truth for DOM parsing.
- Bridge scoring/enrichment endpoints remain the source of truth for filtering, de-dupe, JD cache writes, and `data/pipeline.md` updates.

## Implementation Steps

1. Read router and mode instructions.
   Verify: `CLAUDE.md`, `.claude/skills/career-ops/SKILL.md`, `modes/_shared.md`, and `modes/newgrad-scan.md` identify the expected flow.
2. Check setup and bridge health.
   Verify: required setup files exist; `/v1/health` status is known.
3. Start the bridge if needed.
   Verify: authenticated `/v1/health` returns success.
4. Refresh the extension build.
   Verify: `npm run ext:build` succeeds.
5. Add an autonomous scan script.
   Verify: script compiles and calls the same extractor plus bridge endpoint contracts.
6. Run the autonomous scan.
   Verify: command opens the source page, extracts rows, scores rows, enriches promoted rows, and reports added/skipped counts.

## Verification Approach

- `node update-system.mjs check`
- File existence checks for `cv.md`, `config/profile.yml`, `modes/_profile.md`, and `portals.yml`
- Authenticated curl to `http://127.0.0.1:47319/v1/health`
- `npm run ext:build`
- `node --check` or TypeScript execution smoke check for the autonomous script
- Autonomous scan run result

## Progress Log

- 2026-04-19: User invoked `/career-ops newgrad-scan`.
- 2026-04-19: Update check returned offline with local version `1.3.0`; repo setup files are present.
- 2026-04-19: Initial bridge health check found no listener on `127.0.0.1:47319`.
- 2026-04-19: Started the bridge with `npm run ext:bridge`; it is listening on `127.0.0.1:47319` in real Codex executor mode.
- 2026-04-19: Authenticated health check passed after rerunning outside the sandbox because local loopback requests were blocked by sandbox networking.
- 2026-04-19: Rebuilt the Chrome extension successfully with `npm run ext:build`; output refreshed under gitignored `extension/dist/`.
- 2026-04-19: Re-ran authenticated bridge health successfully after the extension build.
- 2026-04-19: User requested that the agent open the scan source and perform scan/enrich without manual browser work.
- 2026-04-19: Root cause: `modes/newgrad-scan.md` only describes a manual extension workflow even though existing extractors and bridge endpoints can support an autonomous browser-driven CLI flow.
- 2026-04-19: Added `scripts/newgrad-scan-autonomous.ts` and wired `npm run newgrad-scan`.
- 2026-04-19: First autonomous browser run extracted 85 rows, promoted 14, enriched 14, and exposed a URL-quality bug where company homepages could be chosen over concrete job URLs.
- 2026-04-19: Tightened bridge URL scoring so bare company homepages do not beat Jobright detail URLs, and added a regression test.
- 2026-04-19: Second autonomous run exposed auth/analytics URL capture from Google One Tap during apply probing.
- 2026-04-19: Tightened bridge and probe URL scoring to treat `accounts.google.com` as noise and require generic external URLs to carry job/apply/careers signals before outranking Jobright.
- 2026-04-19: Removed bad homepage/auth-log pipeline entries and their generated JD cache files.
- 2026-04-19: Final autonomous run extracted 78 rows, promoted 13, enriched 13, added 2 pipeline entries, skipped 11, and wrote concrete Jobright job URLs for Goldman Sachs and Twitch.
- 2026-04-20: User invoked `/career-ops newgrad-scan`; bridge was not running, so started `npm run ext:bridge`.
- 2026-04-20: Autonomous run extracted 108 rows, promoted 34, enriched 34, added 3 pipeline entries, and skipped 31.
- 2026-04-20: Added pipeline entries for The Baldwin Group, Geneva Trading, and Klaviyo with Jobright job URLs and local JD cache files.
- 2026-04-20: Confirmed no `accounts.google.com` or bare Goldman/Twitch homepage URLs remain in `data/pipeline.md` or `jds/`.
- 2026-04-20: User asked to log into the same browser used by `/career-ops newgrad-scan`; changed the runner to use persistent profile `data/browser-profiles/newgrad-scan`.
- 2026-04-20: Opened the persistent scan profile for user login, then killed the lingering Chrome process that still held `SingletonLock` after login.
- 2026-04-20: Re-ran autonomous scan with the persistent logged-in profile: extracted 119 rows, promoted 31, enriched 31, added 0, skipped 31.
- 2026-04-20: User reported Google sign-in still rejected the browser as insecure.
- 2026-04-20: Added `npm run newgrad-scan:login` to open top-level Jobright in ordinary Google Chrome with the scanner profile, avoiding embedded newgrad-jobs login and Playwright-controlled login contexts.
- 2026-04-20: Added `data/browser-profiles/` to `.gitignore` so local Chrome profile data and cookies cannot be staged accidentally.
- 2026-04-20: After user completed login through the dedicated window, killed the lingering Chrome process holding the profile lock and reran the autonomous scan.
- 2026-04-20: Post-login retest extracted 125 rows, promoted 33, enriched 33, added 0, and skipped 33.
- 2026-04-20: Confirmed the dedicated scan profile still lacked Jobright's `SESSION_ID`; user approved importing only that Jobright cookie into the scanner profile.
- 2026-04-20: Imported `.jobright.ai` `SESSION_ID` into `data/browser-profiles/newgrad-scan` and verified the cookie name and flags without printing the value.
- 2026-04-20: Login-state retest extracted 141 rows, promoted 44, enriched 44, added 8, and skipped 36.
- 2026-04-20: Found one bad added URL, `https://jobright.ai/jobs/recommend`, for Sun West; added a URL-selection regression test and corrected the pipeline/JD URL to the concrete Jobright detail page from scanner browser history.
- 2026-04-21: User invoked `/career-ops newgrad-scan`.
- 2026-04-21: Current run goal is to execute the repo-native autonomous scan, let bridge scoring/enrichment/evaluation handle results, and verify scan outputs without touching unrelated dirty worktree changes.
- 2026-04-21: Success criteria for this run: bridge health passes, `npm run newgrad-scan` completes or reports a concrete blocker, resulting data/report/dashboard changes are identified, and targeted verification is run before reporting completion.
- 2026-04-21: Update check returned `up-to-date` at `1.3.0`; required setup files `cv.md`, `config/profile.yml`, `modes/_profile.md`, and `portals.yml` are present.
- 2026-04-21: Initial bridge health check found no listener, so started `npm run ext:bridge` in `real-codex` mode on `127.0.0.1:47319`.
- 2026-04-21: Bridge health passed with tracker, CV/profile, Codex CLI, and Playwright Chromium OK.
- 2026-04-21: Live scan extracted 213 rows, promoted 59, enriched 59, added 8 pipeline entries, and skipped 51. Skip breakdown: 4 `no_sponsorship`, 8 `site_signal_mixed`, 18 `site_match_below_bar`, 4 `already_evaluated_report`, 2 `active_clearance_required`, 14 `pipeline_threshold`, and 1 `seniority_too_high`.
- 2026-04-21: Added scan candidates for Relativity, WisdomAI, Bose Corporation, Morgan Stanley, Klaviyo, Goldman Sachs, CAI, and Bayview Asset Management.
- 2026-04-21: The scanner queued 7 direct evaluations but initially failed the Bose queue request with `BAD_REQUEST invalid envelope`; root cause was scanner structured-signal strings that could exceed bridge schema max lengths.
- 2026-04-21: The scanner process then exited nonzero while waiting for jobs because `waitForEvaluations()` polled `/v1/jobs/:id` without the required `x-career-ops-token` header.
- 2026-04-21: Fixed `scripts/newgrad-scan-autonomous.ts` so evaluation polling includes the bridge token and structured signal arrays are trimmed to bridge schema string limits before queueing.
- 2026-04-21: Manually requeued the Bose candidate with a minimal valid `newgrad_quick` evaluation payload so the rejected candidate was not lost.
- 2026-04-21: Evaluation results completed: Relativity `3.7/5` report 284, WisdomAI `4.1/5` report 285, Morgan Stanley `3.75/5` report 286, Klaviyo `4.05/5` report 287, Goldman Sachs `3.95/5` report 288, CAI `3.2/5` report 289, Bayview Asset Management `2.35/5` report 290, and Bose Corporation `4.2/5` report 291.
- 2026-04-21: Tracker rows were added for Relativity, WisdomAI, Morgan Stanley, Klaviyo, CAI, Bayview, and Bose. Goldman report 288 was generated, but tracker merge skipped the row as a duplicate of an existing Goldman Sachs application.
- 2026-04-21: Rebuilt the dashboard with `npm run dashboard`; generated `web/index.html` now reports 259 reports, 183 applications, 381 pipeline entries, and 828 scan-history rows.
- 2026-04-21: Verification passed: `npm run newgrad-scan -- --help`, script-level `tsc --noEmit` for `scripts/newgrad-scan-autonomous.ts`, `npm --prefix bridge run typecheck`, `npm --prefix bridge run test -- src/server.test.ts src/adapters/newgrad-links.test.ts src/adapters/newgrad-value-scorer.test.ts`, and `npm run verify`.
- 2026-04-22: User invoked `/career-ops newgrad-scan`.
- 2026-04-22: Current run goal is to execute the default repo-native
  autonomous newgrad scan for today's 24-hour window, including direct
  evaluations for enrich survivors unless the bridge or scanner reports a
  concrete blocker.
- 2026-04-22: Success criteria for this run: update/setup checks pass, bridge
  health passes or is started successfully, `npm run newgrad-scan` completes or
  stops with an actionable failure, resulting data/report/dashboard changes are
  inspected, targeted verification is run, and this plan records the outcome.
- 2026-04-22: Assumptions: required user setup files already present remain the
  source of truth, the existing persistent Jobright profile should be reused,
  default evaluation queueing is desired, and unrelated worktree changes must
  not be reverted.
- 2026-04-22: Update check returned `up-to-date` at `1.3.0`; required setup
  files `cv.md`, `config/profile.yml`, `modes/_profile.md`, `portals.yml`, and
  `data/applications.md` are present.
- 2026-04-22: Initial bridge health check found no listener, so started
  `npm run ext:bridge` in `real-codex` mode. Authenticated `/v1/health`
  passed with tracker, CV/profile, Codex CLI, and Playwright Chromium OK.
- 2026-04-22: `npm run newgrad-scan` used the JobRight API source and returned
  126 rows within 24 hours. It promoted 43, filtered 83, enriched all 43 detail
  pages, added 8 pipeline candidates, and skipped 35. Skip breakdown:
  14 `site_match_below_bar`, 9 `site_signal_mixed`, 8 `no_sponsorship`,
  3 `pipeline_threshold`, and 1 `active_clearance_required`.
- 2026-04-22: Added and queued direct evaluations for AppLovin, Aurora, MUFG,
  Gumloop, Axle, Amazon, AgileGrid Solutions, and Charles Schwab. The scanner's
  built-in evaluation wait completed 4 jobs and timed out on 4 still-running
  bridge jobs; manual bridge polling confirmed all 8 jobs eventually completed.
- 2026-04-22: Generated reports 298-305: AppLovin `4.2/5`, Aurora `3.95/5`,
  MUFG `4.15/5`, Gumloop `4.55/5`, Amazon Applied Scientist `4.15/5`, Axle
  `3.55/5`, AgileGrid Solutions `3.15/5`, and Charles Schwab `2.65/5`. Tracker
  rows were added or updated for all eight.
- 2026-04-22: Rebuilt the dashboard with `npm run dashboard`; generated
  `web/index.html` now reports 273 reports, 193 applications, 389 pipeline
  entries, and 929 scan-history rows.
- 2026-04-22: Verification: `npm run newgrad-scan -- --help` passed.
  `npm run verify` failed because three bridge tests exceeded Vitest's default
  5-second timeout, while tracker/status/report checks, bridge typecheck,
  extension typecheck, and extension build passed. Rerunning the failed bridge
  tests with `npm --prefix bridge run test -- --testTimeout=20000
  src/server.test.ts src/batch/batch-runner.e2e.test.ts` passed.
- 2026-04-21: `npm run verify` finished with 0 errors and 2 existing duplicate warnings: RemoteHunter Software Engineer rows and Anduril Industries Software Engineer rows.
- 2026-04-23: User invoked `/career-ops newgrad-scan`.
- 2026-04-23: Goal: execute the repo-native autonomous newgrad scan for the
  current 24-hour JobRight/newgrad window and let qualifying enrich survivors
  queue direct `newgrad_quick` evaluations.
- 2026-04-23: Success criteria: update/setup checks pass, bridge health is
  available in real Codex mode, `npm run newgrad-scan` completes or reports a
  concrete blocker, generated data/report/dashboard changes are inspected,
  targeted verification is run, and this plan records the outcome.
- 2026-04-23: Assumptions: the persistent scanner browser profile should be
  reused, default direct evaluation is desired, no application should be
  submitted, and unrelated dirty worktree changes must be preserved.
- 2026-04-23: Uncertainties: JobRight may change its API/page shape, login
  state may be stale, live evaluation jobs may outlive the scanner wait window,
  and full verification may hit the known bridge test timeout issue.
- 2026-04-23: Simplest viable path: use existing `npm run newgrad-scan`
  without code changes, start the bridge only if health is unavailable, rebuild
  the dashboard after completed evaluations, then run focused verification.
- 2026-04-23: Update check returned `up-to-date` at `1.3.0`; required setup
  files `cv.md`, `config/profile.yml`, `modes/_profile.md`, `portals.yml`, and
  `data/applications.md` are present. `npm run newgrad-scan -- --help` passed.
- 2026-04-23: Initial authenticated bridge health check failed, so started
  `npm run ext:bridge` in `real-codex` mode. `/v1/health` then passed with
  tracker, CV/profile, Codex CLI, and Playwright Chromium OK.
- 2026-04-23: `npm run newgrad-scan` first attempted Google Chrome with the
  persistent scanner profile, hit `Browser window not found`, and automatically
  fell back to bundled Playwright Chromium. The scan continued successfully.
- 2026-04-23: The JobRight API list source returned 184 rows within 24 hours.
  The scanner promoted 61, filtered 123, enriched all 61 detail pages, added 5
  pipeline candidates, and skipped 56. Skip breakdown:
  26 `site_match_below_bar`, 12 `site_signal_mixed`, 7 `no_sponsorship`,
  7 `pipeline_threshold`, 2 `seniority_too_high`, 1 `already_evaluated_report`,
  and 1 `detail_value_threshold`.
- 2026-04-23: Added and queued direct evaluations for BillGO, LendingClub,
  Nextdoor, Salesforce, and IXL Learning. All 5 evaluations completed with no
  queue failures or timeouts, and all 5 tracker merges returned true.
- 2026-04-23: Generated reports 310-314: LendingClub `3.85/5`, BillGO
  `4.1/5`, Salesforce `4.35/5`, Nextdoor `4.2/5`, and IXL Learning `3.8/5`.
- 2026-04-23: Rebuilt the dashboard with `npm run dashboard`; generated
  `web/index.html` now reports 282 reports, 202 applications, 394 pipeline
  rows, and 1010 scan-history rows.
- 2026-04-23: Verification passed: `npm run newgrad-scan -- --help` passed, and
  `npm run verify` completed with 0 errors and 2 existing duplicate warnings
  for RemoteHunter Software Engineer and Anduril Industries Software Engineer
  tracker rows.
- 2026-04-23: User asked whether `newgrad-scan` enrichment has the same
  inaccurate `pageText` problem just fixed for LinkedIn. Goal: trace the
  newgrad/JobRight enrich path from detail extraction through bridge pipeline
  write and direct `newgrad_quick` evaluation input. Success criteria: identify
  whether JobRight/newgrad detail extraction can send shell/list text as a JD
  excerpt, add a focused guard or regression test only if the issue is present,
  run targeted verification, and record any remaining risk. Assumptions: use
  repository code and local scanner artifacts as the source of truth; do not
  submit applications. Uncertainties: whether the CLI path, extension panel
  path, local JD cache backfill, or direct pending evaluation path is the weak
  point. Simplest viable path: inspect `extractNewGradDetail`,
  `scripts/newgrad-scan-autonomous.ts`, `extension/src/background/index.ts`,
  and `bridge/src/adapters/claude-pipeline.ts`, then build a minimal
  reproduction if broad selectors or low-quality descriptions can reach
  `Description excerpt`.
- 2026-04-23: The issue exists in `newgrad-scan` enrichment, but in a narrower
  form than LinkedIn. Recent JobRight `jds/` cache samples showed good
  structured Requirements and Responsibilities from embedded JobRight data, but
  `detail.description` was often just the page-shell line `Represents the skills
  you have`; `detail.salaryRange` could also be polluted with
  `Turbo for Students: Get Hired Faster!`. That means quick evaluation usually
  still had enough structured JD signal to score, but `Description excerpt` and
  salary could be misleading.
- 2026-04-23: Implemented a scoped fix. `extractNewGradDetail` now rejects the
  known low-value JobRight shell description, composes a fallback description
  from structured requirements/responsibilities when needed, and only accepts
  salary text that looks like an actual pay range. The extension panel enrich
  path now normalizes returned `NewGradDetail` objects the same way, covering
  its older inlined extractor. The quick-evaluation prompt sanitizer also strips
  stale low-value JobRight `Description excerpt` blocks and the fake Turbo
  salary line, so old cache/pending rows do not keep polluting model input.
- 2026-04-23: Minimal reproduction passed. A synthetic JobRight detail page with
  `class="description">Represents the skills you have</div>`, fake Turbo salary,
  and embedded JobRight requirements/responsibilities now extracts an empty
  salary and a structured description:
  `Requirements` with Java/Python/TypeScript and REST/cloud requirements plus
  `Responsibilities` with API/AI-service work.
- 2026-04-23: Verification passed: `npm --prefix extension run typecheck`,
  `npm --prefix bridge run test -- src/adapters/claude-pipeline.test.ts`,
  `npm --prefix bridge run typecheck`, `npm run newgrad-scan -- --help`,
  `npm run ext:build`, script-level TypeScript check for
  `scripts/newgrad-scan-autonomous.ts`, `git diff --check`, and
  `npm run verify`. Full verify completed with 0 errors and the same 2 existing
  duplicate warnings for RemoteHunter Software Engineer and Anduril Industries
  Software Engineer tracker rows.

## Key Decisions

- Use the existing Chrome extension plus bridge workflow instead of creating a parallel scanner path.
- Avoid modifying unrelated dirty files already present in the worktree.
- Reuse existing extractor and bridge scoring/enrichment logic; do not duplicate scoring or pipeline-writing behavior in the new script.
- If the apply-flow probe cannot resolve an ATS/employer URL, keep the Jobright job page rather than a homepage or telemetry URL.
- Browser login state belongs in the persistent user-layer profile under `data/browser-profiles/newgrad-scan`; manual login should use that same profile and the browser must be closed before the next scan.
- Manual Jobright login should be done through top-level `https://jobright.ai/` in a non-automated Chrome window, not inside `newgrad-jobs.com` or a Playwright scan browser, because Google can reject embedded or automated sign-in contexts.
- `jobright.ai/jobs/recommend` is not a concrete job URL and must not outrank a `jobright.ai/jobs/info/...` detail URL.
- Direct evaluation polling must use the bridge token for `/v1/jobs/:id`, same as the create and health endpoints.
- Scanner-provided structured signals must obey the bridge runtime schema limits before queueing evaluations; otherwise one noisy extracted tag can reject the whole candidate.
- When a candidate fails queueing because of a scanner payload issue but has already been written to the pipeline, requeue it with a minimal valid payload rather than rerunning the whole scan.

## Risks and Blockers

- The autonomous run can still fall back to Jobright job pages when the source site does not expose an employer ATS URL without a login/session.
- The repository has unrelated dirty worktree changes from prior work; this task did not revert them.
- The scanner succeeded in writing a Goldman report, but tracker merge skipped it as a duplicate of an existing Goldman Sachs row. This preserves deduplication but means report 288 is not represented as a new top tracker row.
- `npm run verify` currently reports duplicate warnings for RemoteHunter and Anduril rows. They do not block pipeline health, but they remain cleanup candidates.
- The full `npm run verify` command can fail on local bridge test timeout
  thresholds even when the failed tests pass with a longer Vitest timeout. This
  is a verification-environment issue to address separately from scan behavior.

## Final Outcome

Implemented and verified.

Changed behavior:

- `/career-ops newgrad-scan` now documents an autonomous path through `npm run newgrad-scan`.
- `npm run newgrad-scan` opens `https://www.newgrad-jobs.com/`, resolves the embedded Jobright source, extracts list rows with the existing extractor, scores via bridge, enriches details with the existing detail extractor, and writes qualifying rows through bridge.
- URL selection now avoids bare company homepages and Google auth/analytics probe URLs.

Scan result:

- Extracted 78 rows.
- Promoted 13 rows.
- Enriched 13 rows.
- Added 2 pipeline entries.
- Skipped 11 rows: 6 detail value threshold, 4 no sponsorship, 1 experience too high.

Verification run:

- `npm run newgrad-scan -- --help` passed.
- `npm --prefix bridge run test -- src/adapters/newgrad-links.test.ts` passed, 7 tests.
- `npm --prefix extension run typecheck` passed.
- `npm --prefix bridge run typecheck` passed.
- `npm run verify` passed with 0 errors and 1 pre-existing duplicate warning for Anduril tracker rows.

Latest scan run:

- `npm run newgrad-scan` passed on 2026-04-20.
- Extracted 108 rows.
- Promoted 34 rows.
- Enriched 34 rows.
- Added 3 pipeline entries.
- Skipped 31 rows: 15 detail value threshold, 13 no sponsorship, 1 seniority too high, 1 already in pipeline, 1 experience too high.
- `npm run verify` passed with 0 errors and the same 1 pre-existing duplicate warning for Anduril tracker rows.

Post-login scan run:

- `npm run newgrad-scan` passed on 2026-04-20 using `data/browser-profiles/newgrad-scan`.
- Extracted 119 rows.
- Promoted 31 rows.
- Enriched 31 rows.
- Added 0 pipeline entries.
- Skipped 31 rows: 15 detail value threshold, 13 no sponsorship, 1 seniority too high, 1 already in pipeline, 1 experience too high.
- `npm run verify` passed with 0 errors and the same 1 pre-existing duplicate warning for Anduril tracker rows.

Post-login retest after dedicated login window:

- `npm run newgrad-scan` passed on 2026-04-20 using `data/browser-profiles/newgrad-scan`.
- Extracted 125 rows.
- Promoted 33 rows.
- Enriched 33 rows.
- Added 0 pipeline entries.
- Skipped 33 rows: 15 detail value threshold, 15 no sponsorship, 1 seniority too high, 1 already in pipeline, 1 experience too high.
- `npm run verify` passed with 0 errors and the same 1 pre-existing duplicate warning for Anduril tracker rows.

Login cookie import retest:

- User approved importing only `.jobright.ai` `SESSION_ID` into the scanner profile.
- `npm run newgrad-scan` passed on 2026-04-20 using `data/browser-profiles/newgrad-scan`.
- Extracted 141 rows.
- Promoted 44 rows.
- Enriched 44 rows.
- Added 8 pipeline entries.
- Skipped 36 rows: 15 no sponsorship, 3 already in pipeline, 9 detail value threshold, 1 seniority too high, 6 pipeline threshold, 1 active clearance required, 1 experience too high.
- Corrected the Sun West pipeline/JD URL from `jobright.ai/jobs/recommend` to its concrete Jobright detail URL.
- `npm --prefix bridge run test -- src/adapters/newgrad-links.test.ts` passed, 8 tests.
- `npm run verify` passed with 0 errors and the same 1 pre-existing duplicate warning for Anduril tracker rows.

2026-04-21 live run:

- `npm run newgrad-scan` reached scan/enrich/pipeline write successfully, then exited nonzero because evaluation polling omitted the bridge token. The queued jobs still ran to completion in the bridge.
- Added 8 pipeline entries and generated reports 284-291.
- Tracker now includes new rows for Bose, Bayview, CAI, Klaviyo, Morgan Stanley, WisdomAI, and Relativity. Goldman report 288 exists, but the tracker row was dedup-skipped against the existing Goldman Sachs row.
- Fixed scanner polling auth and structured-signal truncation, then verified with help smoke, script typecheck, bridge typecheck, focused bridge tests, dashboard rebuild, and `npm run verify`.

2026-04-22 live run:

- `npm run newgrad-scan` completed scan/enrich/pipeline write successfully and
  queued 8 direct evaluations. The scanner wait window returned with 4 complete
  and 4 timed out, but the bridge continued running and all 8 evaluations
  reached terminal `completed` state after manual monitoring.
- Generated reports 298-305 and updated tracker/dashboard state for AppLovin,
  Aurora, MUFG, Gumloop, Amazon Applied Scientist, Axle, AgileGrid Solutions,
  and Charles Schwab.
- `npm run dashboard` and `npm run newgrad-scan -- --help` passed.
- Full `npm run verify` completed tracker/status/report checks but failed on 3
  bridge test timeouts under the default 5-second Vitest limit. The same failed
  bridge tests passed with `--testTimeout=20000`.

2026-04-23 live run:

- `npm run newgrad-scan` completed scan/enrich/pipeline write successfully and
  queued 5 direct evaluations.
- Generated reports 310-314 and merged tracker rows for LendingClub, BillGO,
  Salesforce, Nextdoor, and IXL Learning.
- Rebuilt `web/index.html`; dashboard counts are now 282 reports,
  202 applications, 394 pipeline rows, and 1010 scan-history rows.
- `npm run newgrad-scan -- --help` and `npm run verify` passed. Verification
  has 0 errors and 2 pre-existing duplicate tracker warnings.
