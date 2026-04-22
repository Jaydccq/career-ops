# Tech Debt Tracker

Durable record of known gaps that should not live only in chat.

| Date | Area | Gap | Impact | Suggested Fix | Status |
|------|------|-----|--------|---------------|--------|
| 2026-04-21 | `batch/batch-runner.sh` | Report-number discovery loops over `reports/*.md` and assumes every basename begins with a numeric prefix. Non-report markdown files such as `reports/CLAUDE.md` can make arithmetic expansion fail. | Batch workers can start with an empty or corrupt report number, producing duplicate or malformed reports and pending tracker-addition TSVs. | Restrict report-number parsing to filenames matching `^[0-9]+-.*\\.md$`, add a shell test fixture with `reports/CLAUDE.md`, and fail before spawning workers if no report number can be reserved. | Open |
| 2026-04-22 | `bridge/src/batch/batch-runner.e2e.test.ts` | The two batch-runner e2e tests regularly exceed Vitest's default 5s timeout during `npm run verify`; the same file passes with `--testTimeout=20000`. | Full pipeline verification can report a false red even when the batch e2e behavior passes under a realistic timeout. | Set an explicit per-test or file-level timeout for the batch-runner e2e tests, then keep `npm run verify` on the default command. | Open |
