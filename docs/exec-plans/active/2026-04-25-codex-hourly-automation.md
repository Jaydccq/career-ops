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

## Key decisions

- Use a single local orchestration command instead of putting multi-step logic
  in the Codex Automation prompt.
- Keep the script configurable through environment variables so the automation
  can be tuned without adding more scripts.
- Do not start a local listening bridge from Codex Automation by default. The
  automation sandbox can reject `listen()` with `EPERM`, so scheduled runs
  should either reuse an already-running bridge or fall back to preview mode.
- Keep LinkedIn automation freshness narrower than the manual profile default:
  use `f_TPR=r4000` for scheduled hourly runs instead of the broader
  `f_TPR=r86400` 24-hour window.

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

## Final outcome

Implemented. The automation command is `npm run auto:hourly-scan`, with
`npm run auto:hourly-scan:dry` available for explicit preview runs. Codex App
setup steps are documented in `docs/codex-hourly-scan-automation.md`. Missing
bridge now degrades to preview mode instead of blocking all source scans.
