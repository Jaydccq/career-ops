# JobRight Bb-Browser Adapter

## Background

The bb-browser site system turns website functionality into CLI commands by
running adapter JavaScript in the user's browser context. Career-Ops already has
a JobRight/newgrad scan path, but `bb-browser site search jobright` did not find
an adapter.

## Goal

Add a read-only JobRight bb-browser site command that returns structured job
listing data from the JobRight newgrad minisite.

## Scope

- Add one `jobright/newgrad` site adapter.
- Parse JobRight's server-rendered `__NEXT_DATA__.props.pageProps.initialJobs`
  payload instead of relying on fragile visual table classes.
- Install the adapter into bb-browser's private adapter directory for local CLI
  use.
- Do not change the existing Career-Ops scan, scoring, pipeline, tracker, or
  application submission behavior.

## Assumptions

- The user's request means "make jobright.ai available through bb-browser's
  `site` CLI adapter system."
- The current newgrad SWE minisite, `newgrad/us/swe`, is the useful default
  because it is the existing Career-Ops JobRight source.
- A read-only list adapter is the simplest viable path; detail enrichment and
  Career-Ops scoring remain owned by the existing scanner.

## Implementation Steps

1. Inspect bb-browser site adapter conventions and JobRight's live page shape.
   Verify: identify adapter metadata requirements and a stable data source.
2. Add a local adapter source file.
   Verify: adapter metadata parses and exposes a `jobright/newgrad` command.
3. Install the adapter into `~/.bb-browser/sites/jobright/newgrad.js`.
   Verify: `bb-browser site search jobright --json` finds it.
4. Smoke test extraction.
   Verify: `bb-browser site jobright/newgrad 5 --json` returns real job rows.

## Verification Approach

- `bb-browser site search jobright --json`
- `bb-browser site info jobright/newgrad`
- `bb-browser site jobright/newgrad 5 --json`
- `node --check bb-browser/sites/jobright/newgrad.js`

## Progress Log

- 2026-04-21: Created plan after the user asked to CLI-ify `jobright.ai` with
  bb-browser.
- 2026-04-21: Confirmed no existing JobRight adapter was installed.
- 2026-04-21: Opened the live JobRight newgrad SWE page with bb-browser and
  confirmed the page exposes jobs in `#__NEXT_DATA__`.
- 2026-04-21: Added `bb-browser/sites/jobright/newgrad.js` and installed it to
  `~/.bb-browser/sites/jobright/newgrad.js`.
- 2026-04-21: Verification passed:
  `node --check bb-browser/sites/jobright/newgrad.js`,
  `bb-browser site search jobright --json`,
  `bb-browser site info jobright/newgrad`, and
  `bb-browser site jobright/newgrad 5 --json`.

## Key Decisions

- Use `initialJobs` from `__NEXT_DATA__` rather than DOM table scraping. This
  preserves structured fields and avoids depending on generated CSS class names.
- Keep the adapter read-only. It fetches and parses listing data only.

## Risks And Blockers

- JobRight may rename or move the `initialJobs` payload.
- The adapter depends on the browser being able to access JobRight; login or
  network issues should surface as structured errors.

## Final Outcome

`jobright/newgrad` is available as a local bb-browser site adapter. It fetches
the JobRight newgrad minisite in the browser context, parses
`props.pageProps.initialJobs`, and returns structured JSON rows. The adapter is
read-only and does not mutate Career-Ops tracker, pipeline, scan history, or
application state.
