# Tech Debt Tracker

Durable record of known gaps that should not live only in chat.

| Date | Area | Gap | Impact | Suggested Fix | Status |
|------|------|-----|--------|---------------|--------|
| 2026-04-21 | `batch/batch-runner.sh` | Report-number discovery loops over `reports/*.md` and assumes every basename begins with a numeric prefix. Non-report markdown files such as `reports/CLAUDE.md` can make arithmetic expansion fail. | Batch workers can start with an empty or corrupt report number, producing duplicate or malformed reports and pending tracker-addition TSVs. | Restrict report-number parsing to filenames matching `^[0-9]+-.*\\.md$`, add a shell test fixture with `reports/CLAUDE.md`, and fail before spawning workers if no report number can be reserved. | Open |
