# Mode: linkedin-scan -- LinkedIn Jobs Scanner

Scans a LinkedIn Jobs search page through the authenticated `bb-browser`
profile, scores visible jobs with the existing newgrad scanner, enriches
promoted detail pages, and optionally queues `newgrad_quick` evaluations.

## Prerequisites

- Bridge server running (`npm --prefix bridge run start`)
- `bb-browser` installed and on `PATH`
- LinkedIn logged in inside the `bb-browser` managed browser

If LinkedIn requires login or checkpoint recovery, run:

```bash
bb-browser open https://www.linkedin.com/login
```

Log in manually in that browser, then rerun the scan.

## Execution

### Step 1: Verify bridge

Check `/v1/health`. If it is not reachable, tell the user:

> "Start the bridge first: `npm --prefix bridge run start`"

### Step 2: Run a no-write preview

Use the supplied 24-hour LinkedIn Jobs search URL shape:

```text
https://www.linkedin.com/jobs/search-results/?currentJobId=4347121472&keywords=software%20ai%20engineer%20new%20graduate%20job%20posted%20in%20the%20past%2024%20hours&origin=JOB_SEARCH_PAGE_JOB_FILTER&f_TPR=r86400
```

Preview:

```bash
npm run linkedin-scan -- --url "<LinkedIn Jobs URL>" --score-only --limit 20
```

`--score-only` extracts and scores rows without calling bridge write endpoints.

### Step 3: Enrich and write candidates

Run:

```bash
npm run linkedin-scan -- --url "<LinkedIn Jobs URL>" --no-evaluate --enrich-limit 5
```

This opens promoted LinkedIn job-view pages, extracts detail text, writes
qualifying rows to `data/pipeline.md` as `linkedin-scan`, and does not queue
formal evaluations.

Default behavior without `--no-evaluate` queues `newgrad_quick` evaluations for
enrich survivors and waits for completion.

Useful options:

```bash
npm run linkedin-scan -- --url "<LinkedIn Jobs URL>" --score-only --limit 5
npm run linkedin-scan -- --url "<LinkedIn Jobs URL>" --score-only --pages 4 --limit 100
npm run linkedin-scan -- --url "<LinkedIn Jobs URL>" --no-evaluate --enrich-limit 2
npm run linkedin-scan -- --url "<LinkedIn Jobs URL>" --evaluate-limit 3
npm run linkedin-scan -- --bridge-host 127.0.0.1 --bridge-port 47319
```

Use `--pages` for larger LinkedIn result-set testing. The scanner opens
successive search-result URLs with `start` offsets. The current LinkedIn
`search-results` route exposes 6 jobs per offset page by default; override with
`--page-size` if LinkedIn changes the result shape. Rows are deduped by
canonical LinkedIn job URL before scoring, so overlapping result pages do not
create duplicate candidates. Use `--scroll-steps` to probe virtualized lists
within each result page; each probe is a short read-only scroll plus re-extract.

If no `--url` is passed, the script reads
`config/profile.yml -> linkedin_scan.search_url`.

## Safety Boundaries

- Never submit applications.
- Never click Apply, Easy Apply, Save, Dismiss, message, or recruiter controls.
- Keep LinkedIn job-view URLs as pipeline URLs when the external ATS URL is
  hidden behind an Apply button.
- Treat login, checkpoint, and account-verification pages as manual recovery
  states.

## Output Summary

When reporting results, include:

- Search URL used.
- Rows extracted.
- Promoted and filtered counts.
- Detail enrichment successes and failures.
- Pipeline entries added or skipped.
- Evaluation jobs queued/completed unless `--no-evaluate` was used.
