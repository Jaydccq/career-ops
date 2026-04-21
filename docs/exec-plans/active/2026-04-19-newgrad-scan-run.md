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
- 2026-04-21: `npm run verify` finished with 0 errors and 2 existing duplicate warnings: RemoteHunter Software Engineer rows and Anduril Industries Software Engineer rows.

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
