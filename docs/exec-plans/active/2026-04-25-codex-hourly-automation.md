# Codex hourly scan automation

## Background

The project already has source-specific scanners for zero-token portal scan,
newgrad-jobs, Built In, LinkedIn, and Indeed. Codex Automation needs one stable
project command that can run safely on a schedule without overlapping itself or
running outside the requested weekday business window.

## Goal

Add a local-project automation entrypoint for weekday hourly scans from 08:00
through 22:00 America/New_York, and document the Codex App setup steps.

## Scope

- Add an npm script that runs one hourly scan orchestration command.
- Add a small Node orchestration script for time-window guard, locking, bridge
  readiness, source execution, post-scan maintenance, and summary output.
- Add durable Codex Automation setup instructions in `docs/`.
- Add only the profile/config needed for existing scanners to run unattended.

## Assumptions

- Automation should run against the local project checkout because scanners
  write user-layer artifacts under `data/`, `reports/`, `batch/`, and `web/`.
- The schedule is intended for America/New_York.
- The automation must never submit applications or click final application
  controls.
- The existing `newgrad_quick` evaluation mode is the right default for hourly
  runs.

## Implementation steps

1. Add `scripts/hourly-job-scan.mjs` and npm scripts.
   Verify: command help/dry run and syntax checks pass.
2. Add LinkedIn default search URL if missing.
   Verify: LinkedIn scanner can resolve a URL from profile config.
3. Add Codex Automation setup documentation.
   Verify: docs link from `docs/CODEX.md` and include local-project setup,
   schedule, prompt, safety boundaries, recovery commands, and tuning knobs.
4. Run targeted verification.
   Verify: dry-run command can start, apply the time-window override, and write
   an automation summary without full live evaluations.
5. Make bridge startup sandbox-safe.
   Verify: when no bridge is reachable and auto-start is disabled, the command
   continues in preview mode and writes a summary instead of failing before
   source scans start.
6. Narrow LinkedIn automation freshness.
   Verify: hourly automation passes a LinkedIn URL with `f_TPR=r4000` by
   default while preserving the profile URL as the base query.
7. Fix retry blockers from the bridge-enabled catch-up run.
   Verify: top-level bridge probe waits for a just-started real/codex bridge,
   and Indeed command construction omits empty `--location`.
8. Preserve the user-selected Indeed search filters for scheduled scans.
   Verify: hourly automation builds the Indeed command with `--url` from
   profile config or `CAREER_OPS_INDEED_URL`.

## Verification approach

- `node --check scripts/hourly-job-scan.mjs`
- `npm run auto:hourly-scan:dry` with `CAREER_OPS_SCAN_IGNORE_WINDOW=1` and a
  narrow source list if live browser state allows it.
- `npm run verify` if targeted checks do not expose environment blockers.
- `CAREER_OPS_SCAN_IGNORE_WINDOW=1 CAREER_OPS_SCAN_SOURCES= npm run
  auto:hourly-scan` to verify the no-bridge preview fallback without running
  live source scans.

## Progress log

- 2026-04-25: Created plan after reading `CLAUDE.md`, `docs/CODEX.md`,
  `package.json`, profile config, portals config, and scanner docs/options.
- 2026-04-25: Added `scripts/hourly-job-scan.mjs`, npm automation scripts,
  LinkedIn profile default URL, and Codex Automation setup documentation.
- 2026-04-25: Verified `node --check scripts/hourly-job-scan.mjs`,
  `package.json` JSON parsing, `git diff --check` for changed files, and a
  no-source dry automation run with `CAREER_OPS_SCAN_IGNORE_WINDOW=1`.
- 2026-04-25: Ran `npm run verify`; it passed with existing duplicate warnings
  for RemoteHunter and Anduril rows.
- 2026-04-25: Automation run `npm run auto:hourly-scan` did not reach source
  execution because local sandbox permissions blocked bridge startup. `tsx`
  failed to listen on its IPC pipe, and direct compiled bridge startup failed to
  listen on `127.0.0.1:47319`. Recorded the blocked run in
  `data/automation/hourly-scan-2026-04-25T02-08-17Z-blocked.md`.
- 2026-04-25: Updated `scripts/hourly-job-scan.mjs` so automation no longer
  tries to start the bridge by default. It now reuses an existing real/codex
  bridge when available and otherwise runs read-only preview commands, recording
  the bridge recovery command in the summary. Automatic startup remains
  available with `CAREER_OPS_SCAN_START_BRIDGE=1`; hard failure remains
  available with `CAREER_OPS_SCAN_REQUIRE_BRIDGE=1`.
- 2026-04-25: Verified the no-bridge fallback with
  `CAREER_OPS_BRIDGE_PORT=9 CAREER_OPS_SCAN_IGNORE_WINDOW=1
  CAREER_OPS_SCAN_SOURCES= npm run auto:hourly-scan`; it exited successfully,
  wrote a summary with `bridge_unavailable_preview`, and did not try to listen
  on localhost. Removed the temporary verification summary afterward.
- 2026-04-25: Ran `npm run verify`; it passed with the existing duplicate
  warnings for RemoteHunter and Anduril rows.
- 2026-04-25: Updated hourly automation so LinkedIn scans derive their base URL
  from `config/profile.yml -> linkedin_scan.search_url` or
  `CAREER_OPS_LINKEDIN_URL`, then replace `f_TPR` with
  `CAREER_OPS_LINKEDIN_POSTED_WITHIN` defaulting to `r4000`. This keeps hourly
  LinkedIn scans focused on the newest roughly last-hour postings while manual
  LinkedIn scans can still use the profile URL directly.
- 2026-04-25: Verified the LinkedIn URL transform with a Node YAML parse check;
  generated automation URL had `f_TPR=r4000`. Also reran `node --check
  scripts/hourly-job-scan.mjs`, `git diff --check`, and `npm run verify`.
- 2026-04-25 03:25Z: Ran `npm run auto:hourly-scan` from the local checkout for
  the job-search automation. The command exited before source execution because
  it was outside the configured America/New_York schedule window, so no sources
  ran, no evaluations completed, and no new `data/automation` summary was
  written. Manual catch-up command: `CAREER_OPS_SCAN_IGNORE_WINDOW=1 npm run
  auto:hourly-scan`.
- 2026-04-25 03:47Z: Ran the requested test catch-up with
  `CAREER_OPS_SCAN_IGNORE_WINDOW=1 npm run auto:hourly-scan`. The sandbox run
  wrote `data/automation/hourly-scan-2026-04-25T03-46-15-821Z.md` but hit DNS
  failures and `tsx` IPC `EPERM`, so the command was rerun with approved
  unsandboxed execution. The unsandboxed run wrote
  `data/automation/hourly-scan-2026-04-25T03-46-46-635Z.md`, ran requested
  sources `scan`, `newgrad`, `builtin`, `linkedin`, and `indeed`, and completed
  0 evaluations because no real/codex bridge was reachable. Direct scan ran in
  read-only preview mode and found 9 newest candidate roles, but did not write
  them or queue evaluations. Blockers: bridge unavailable
  (`npm run ext:bridge`), Built In browser daemon Chrome/CDP disconnected
  (`bb-browser daemon shutdown && bb-browser tab list`), Newgrad and LinkedIn
  failed bridge health checks with `fetch failed`, Indeed failed with
  `missing value for --location`, and Pallet returned HTTP 404 in direct scan.
- 2026-04-25 03:50Z: After the user started the bridge, reran
  `CAREER_OPS_SCAN_IGNORE_WINDOW=1 npm run auto:hourly-scan` with approved
  unsandboxed execution. The run wrote
  `data/automation/hourly-scan-2026-04-25T03-50-10-526Z.md`. The top-level
  orchestration bridge probe still reported `bridge_unavailable_preview`, so
  direct scan stayed dry-run and no evaluations were queued. Source status:
  `scan` ok, `newgrad` ok, `builtin` failed, `linkedin` failed, `indeed`
  failed. Newgrad scanner itself reported `Bridge health: ok`, read 50 JobRight
  API rows within 24h, promoted 19, filtered 31, and wrote
  `data/scan-runs/newgrad-20260425T034956Z-66083039-summary.json`. Completed
  evaluations remained 0. Remaining blockers: browser daemon Chrome/CDP
  disconnected for Built In and LinkedIn (`bb-browser daemon shutdown &&
  bb-browser tab list`), Indeed still passes an empty `--location`, and Pallet
  still returns HTTP 404.
- 2026-04-25: Confirmed the current bridge health payload is
  `execution.mode=real` and `execution.realExecutor=codex`. Updated the
  orchestrator to poll briefly for a just-started bridge before preview
  fallback, and to omit the Indeed `--location` option when
  `CAREER_OPS_INDEED_LOCATION` is empty.
- 2026-04-25 04:20Z: Restarted the bb-browser daemon with
  `bb-browser daemon shutdown` and verified Chrome/CDP recovery with
  `bb-browser tab list`. Ran a full catch-up using
  `CAREER_OPS_SCAN_IGNORE_WINDOW=1 npm run auto:hourly-scan` in the approved
  local environment. The orchestrator detected the existing real/codex bridge,
  ran all sources, wrote
  `data/automation/hourly-scan-2026-04-25T04-19-55-048Z.md`, and completed 6
  evaluations: 3 from direct scan, 1 from newgrad, and 2 from LinkedIn. High
  results were Uber Graduate 2026 Software Engineer I Mobile iOS at 4.55/5 and
  Jobright.ai AI Engineer Entry Level at 4.3/5. Built In still failed with
  truncated bb-browser JSON, one LinkedIn candidate failed `/v1/evaluate` with
  invalid envelope, and direct scan still had Pallet HTTP 404. Indeed no longer
  failed on empty `--location`; it ran and skipped two candidates for
  `salary_below_minimum`.
- 2026-04-25: The full run exposed a tracker table break from a LinkedIn title
  containing `|`. Repaired `data/applications.md` row #358 for Loop, added a
  `merge-tracker.mjs` cell sanitizer, and added a bridge merge-tracker test for
  pipe-containing role titles. `npm run verify` passed afterward with only the
  existing RemoteHunter and Anduril duplicate warnings.
- 2026-04-25: Updated the hourly orchestrator so Indeed scans prefer a full
  search URL from `CAREER_OPS_INDEED_URL` or
  `config/profile.yml -> indeed_scan.search_url`. Added the user's entry-level
  Indeed URL to profile config so the scheduled run preserves the `sc=` filter
  instead of rebuilding a plain query/location search.
- 2026-04-25: Verified the Indeed URL change with `node --check
  scripts/hourly-job-scan.mjs`, `git diff --check` for touched files, a Node
  YAML parse check showing `q=software engineer, AI engineer`, empty `l=`, and
  `sc=0kf:explvl(ENTRY_LEVEL);`, plus a score-only Indeed smoke test. The smoke
  test parsed 16 rows from the supplied URL, kept 5 under the test limit,
  promoted 1, filtered 4, and called no bridge write endpoints.

## Key decisions

- Use a single local orchestration command instead of putting multi-step logic
  in the Codex Automation prompt.
- Keep the script configurable through environment variables so the automation
  can be tuned without adding more scripts.
- Do not start a local listening bridge from Codex Automation by default. The
  automation sandbox can reject `listen()` with `EPERM`, so scheduled runs
  should either reuse an already-running bridge or fall back to preview mode.
- Wait up to `CAREER_OPS_SCAN_BRIDGE_WAIT_MS` for bridge readiness so a bridge
  started immediately before the automation run does not cause a false preview
  fallback.
- Sanitize markdown tracker cells in `merge-tracker.mjs` because generated TSV
  fields can legitimately contain `|` from job-board titles.
- Keep LinkedIn automation freshness narrower than the manual profile default:
  use `f_TPR=r4000` for scheduled hourly runs instead of the broader
  `f_TPR=r86400` 24-hour window.
- Keep user-selected Indeed filters as a full URL in profile config, because
  query/location reconstruction drops SERP filters such as entry-level `sc=`.

## Risks and blockers

- LinkedIn, Indeed, or Jobright may require manual login/checkpoint recovery.
- Real Codex bridge mode depends on the local `codex` CLI and bridge
  dependencies being available.
- Full live verification may be expensive or slow because it can queue
  evaluations.
- Codex sandbox environments that disallow local listening sockets cannot start
  the real/codex bridge. In that case the automation will run preview scans
  only. Recovery for full evaluations is to keep `npm run ext:bridge` running
  from a normal local terminal before the scheduled run.
- Built In and external ATS detail reads can still return truncated JSON from
  bb-browser when page text/output is large; this remains the next reliability
  gap.
- One LinkedIn candidate failed evaluation queueing with `BAD_REQUEST invalid
  envelope`; inspect the candidate payload before relying on fully unattended
  LinkedIn evaluation for all promoted rows.

## Final outcome

Implemented. The automation command is `npm run auto:hourly-scan`, with
`npm run auto:hourly-scan:dry` available for explicit preview runs. Codex App
setup steps are documented in `docs/codex-hourly-scan-automation.md`. Missing
bridge now degrades to preview mode instead of blocking all source scans.
