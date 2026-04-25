# Codex hourly scan automation

This automation runs Career-Ops job discovery every weekday hour from 08:00
through 22:00 America/New_York. It uses the local checkout because this workflow
writes user-layer artifacts under `data/`, `reports/`, `batch/`, and `web/`.

## Repository setup

The automation command is:

```bash
npm run auto:hourly-scan
```

For a no-evaluation preview:

```bash
CAREER_OPS_SCAN_IGNORE_WINDOW=1 npm run auto:hourly-scan:dry
```

The dry command still runs scanner read paths, but it skips bridge startup,
write-path evaluation, tracker maintenance, and dashboard rebuild.

## Codex App setup

1. Open Codex Automations.
2. Create a new project-scoped automation for this `career-ops` project.
3. Choose the local project checkout as the run location. Do not use a worktree
   for this workflow because the scanners depend on local browser state and
   write normal project artifacts.
4. Set the schedule to weekdays, hourly, 08:00 through 22:00,
   America/New_York. If the UI only accepts cron syntax, use:

   ```text
   0 8-22 * * 1-5
   ```

5. Use this prompt:

   ```text
   In this project, run:

   npm run auto:hourly-scan

   Use the local project checkout, not a worktree. Do not submit any job applications. Do not click Apply, Easy Apply, Save, job alert, resume upload, or final submit controls.

   The goal is to scan the newest jobs from the configured Career-Ops sources, enrich matching roles, run capped newgrad_quick evaluations, update tracker/report artifacts through the existing pipeline, rebuild the dashboard, and summarize the run.

   After the command finishes, report:
   1. Which sources ran
   2. How many evaluations completed
   3. Any source blocked by login, checkpoint, rate limit, verification, or parsing error
   4. The newest high-fit roles worth reviewing
   5. The summary file path under data/automation

   If a source fails because manual login or verification is required, do not try to bypass it. Report the exact recovery command.
   ```

## What the command does

`scripts/hourly-job-scan.mjs`:

- Checks the America/New_York weekday 08:00-22:00 schedule window.
- Takes `data/automation/hourly-scan.lock` to avoid overlapping hourly runs.
- Reuses an existing bridge in `real/codex` mode for write/evaluation paths.
- If no bridge is reachable, continues in read-only preview mode instead of
  failing before source scans start. In preview mode it does not write pipeline
  candidates, queue evaluations, merge tracker rows, or rebuild the dashboard.
- Runs the configured source list, defaulting to
  `scan,newgrad,builtin,linkedin,indeed`.
- For LinkedIn automation runs, reads `config/profile.yml ->
  linkedin_scan.search_url` as the base search and replaces `f_TPR` with
  `r4000` by default. `f_TPR=r86400` means roughly posted in the last 24 hours;
  `r4000` keeps hourly automation focused on the newest roughly last-hour
  postings.
- Uses `newgrad_quick` by default with `CAREER_OPS_SCAN_EVALUATE_LIMIT=3`.
- Runs tracker/dashboard maintenance after successful live scans.
- Writes `data/automation/hourly-scan-*.md` with source status, completed
  evaluation count, blocker recovery commands, high-fit roles, and output tails.

## Tuning knobs

Set these in the automation environment only when needed:

```bash
CAREER_OPS_SCAN_SOURCES=newgrad,builtin,linkedin,indeed
CAREER_OPS_SCAN_EVAL_MODE=newgrad_quick
CAREER_OPS_SCAN_EVALUATE_LIMIT=3
CAREER_OPS_SCAN_ENRICH_LIMIT=10
CAREER_OPS_SCAN_STEP_TIMEOUT_MS=2700000
CAREER_OPS_SCAN_IGNORE_WINDOW=1
CAREER_OPS_SCAN_DRY_RUN=1
CAREER_OPS_SCAN_START_BRIDGE=1
CAREER_OPS_SCAN_REQUIRE_BRIDGE=1
CAREER_OPS_LINKEDIN_POSTED_WITHIN=r4000
CAREER_OPS_LINKEDIN_URL="https://www.linkedin.com/jobs/search-results/?keywords=software%20ai%20engineer%20new%20graduate&f_TPR=r4000"
```

`CAREER_OPS_SCAN_START_BRIDGE=1` restores automatic bridge startup. Use it only
from an environment that can listen on localhost; Codex Automation sandbox runs
can return `listen EPERM` when they try to start a local server.

`CAREER_OPS_SCAN_REQUIRE_BRIDGE=1` makes missing bridge a hard failure instead
of a read-only preview fallback.

For an occasional deeper manual run:

```bash
CAREER_OPS_SCAN_IGNORE_WINDOW=1 \
CAREER_OPS_SCAN_EVAL_MODE=default \
CAREER_OPS_SCAN_EVALUATE_LIMIT=5 \
CAREER_OPS_SCAN_SOURCES=newgrad,builtin,linkedin,indeed \
npm run auto:hourly-scan
```

## Manual recovery

- LinkedIn login/checkpoint: `bb-browser open https://www.linkedin.com/login`
- Indeed verification: `bb-browser open https://www.indeed.com`
- Jobright/newgrad login: `npm run newgrad-scan:login`
- Bridge recovery: `npm run ext:bridge`

Complete manual login or verification in the opened browser, close any manual
scan browser window that uses the same profile, then let the next automation run
or rerun the command manually.

If Codex Automation reports `listen EPERM`, start the bridge once from a normal
local terminal:

```bash
npm run ext:bridge
```

Keep that terminal process running. The next hourly automation run will reuse
the existing bridge and enable writes/evaluations.
