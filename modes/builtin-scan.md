# Mode: builtin-scan -- Built In Scanner

Scans Built In job searches with the existing Career-Ops scanner and supports
manual extension scans on live Built In result pages.

## When To Use

Use this mode when the user asks for Built In discovery, BuiltIn discovery, or
`/career-ops builtin-scan`.

Use the broader `scan` mode when the user wants every configured portal and
company source.

## What Already Exists

- `scan.mjs --builtin-only` fetches configured Built In keyword searches.
- `templates/portals.example.yml -> builtin_searches` defines versioned default
  keywords.
- `portals.yml -> builtin_searches` can override the local keyword set.
- The browser extension detects `builtin.com` pages and reuses the existing
  scan, score, enrich, pipeline, and evaluation flow.
- Built In rows are persisted with the `builtin-scan` source tag.

Do not create a separate Built In pipeline. Reuse the existing scanner flow.

## Recommended CLI Flow

### Step 1: Preview Built In results

Run:

```bash
npm run builtin-scan -- --dry-run
```

Expected behavior:
- Fetches only Built In keyword searches.
- Applies `portals.yml -> title_filter`.
- Deduplicates against `data/scan-history.tsv`, `data/pipeline.md`, and
  `data/applications.md`.
- Prints candidate counts and matching roles.
- Does not write files.

### Step 2: Save new results if the preview looks useful

Run:

```bash
npm run builtin-scan
```

Expected behavior:
- Appends new matching roles to `data/pipeline.md`.
- Appends added Built In rows to `data/scan-history.tsv` with portal
  `builtin-scan`.

### Step 3: Evaluate saved roles

After saving:

```bash
/career-ops pipeline
```

Use pipeline or batch evaluation for the resulting pending URLs. Do not submit
applications automatically.

Bridge consumers can read the saved Built In inbox with:

```text
POST /v1/builtin-scan/pending
```

This is a read-only endpoint. It parses unchecked Built In rows in
`data/pipeline.md`, skips tracker/report duplicates, and returns entries with
`url`, `company`, `role`, `source`, and `lineNumber`.

## Manual Browser Extension Flow

Use this when the user wants a specific Built In page or manually selected
filters to be the source of truth.

1. Open the Built In result URL in Chrome.
2. Start the local bridge if needed:

```bash
npm run ext:bridge
```

3. Open the Career-Ops extension panel.
4. Confirm the panel shows the Built In scanner.
5. Click the scan button to extract visible cards.
6. Enrich promoted rows before evaluation so detail page text, external Apply
   URLs, and full job metadata are cached.

## Built In Page Model

Observed on 2026-04-21 from:

`https://builtin.com/jobs/hybrid/office?search=Software+Engineering&city=Durham&state=North+Carolina&country=USA&allLocations=true`

Result page:
- Page title: `Top Jobs For Your Search`.
- Job cards: `[id^="job-card-"]` with `data-id="job-card"`.
- Job title links: `a[data-id="job-card-title"]`, usually `/job/.../{id}`.
- Company links: `a[data-id="company-title"]`; cards may also contain an
  empty logo link to `/company/...` before the textual company link.
- Cards expose company, title, posted age, work model, location or location
  count, salary when present, seniority, industry, summary, and top skills.
- Non-job blocks can appear between cards, such as resume upload prompts and
  application tracker ads.

Detail page:
- Main title is the `h1`.
- Company is linked near the top and again near company/profile actions.
- Metadata includes posted/reposted timing, location, work model, seniority,
  industry, top skills, and company information.
- Full descriptions can be visually collapsed behind `Read Full Description`.
- Apply can be an external ATS link, such as Workday, or can require Built In
  account context.

## Important Caveats

- `allLocations=true` broadens results. A URL can contain `city`, `state`, and
  `country` while still returning Raleigh, multi-location, national, remote, or
  hybrid roles. Report this clearly when using a user-supplied city URL.
- City URLs should be treated as regional result pages, not strict city-only
  filters. On 2026-04-21, Seattle, San Francisco, Denver, and New York searches
  each returned 25 visible cards and included a mix of exact-city rows,
  nearby-city rows, and `N Locations` rows.
- Built In search pages include auth, cookie consent, resume upload, job alert,
  tracker, similar job, and footer links. Scanners must anchor on job-card
  selectors and `/job/` links rather than generic links.
- Posted strings include forms like `Reposted Yesterday`, `Reposted 4 Days Ago`,
  `7 Days Ago`, and `24 Days Ago`.
- Salary and seniority can appear twice in text output. Normalization should
  deduplicate semantically rather than treating duplicate text as separate
  fields.
- Some cards show location counts such as `25 Locations` instead of a concrete
  city.
- Some role titles are leadership or manager roles even when the search keyword
  is `Software Engineering`; trust title filters and scoring, not the Built In
  keyword alone.
- External Apply URLs are useful metadata, but the assistant must never click
  through to submit an application.

## Location Test Notes

Use this URL shape for manual city testing:

```text
https://builtin.com/jobs/hybrid/office?search=Software+Engineering&city={City}&state={State}&country=USA
```

Add `allLocations=true` only when the user explicitly wants broader discovery.
In live tests on 2026-04-21, the first page behaved as follows:

| Location | `allLocations=true` cards | City params only cards | Notes |
|----------|---------------------------|------------------------|-------|
| Seattle, WA | 25 | 25 | Mixed exact Seattle, multi-location, and regional rows |
| San Francisco, CA | 25 | 25 | Multiple exact San Francisco rows in the first page |
| Denver, CO | 25 | 25 | Included Denver, Broomfield, and multi-location rows |
| New York, NY | 25 | 25 | Included New York, Brooklyn, and multi-location rows |

The CLI `npm run builtin-scan` currently runs configured keyword searches as
all-location discovery. Use the browser extension flow when a specific live
city-filtered Built In page must be the source of truth.

## Customizing Built In Searches

Edit local `portals.yml`:

```yaml
builtin_searches:
  - name: Built In - Software Engineering
    keyword: Software Engineering
    enabled: true
  - name: Built In - AI Engineer
    keyword: AI Engineer
    enabled: true
```

Use `enabled: false` to temporarily disable a keyword. Keep user-specific
keywords in local `portals.yml`; update `templates/portals.example.yml` only
when changing shared defaults.

## Output Summary

When reporting results, include:
- Number of Built In searches fetched.
- Total jobs found.
- Title-filter removals.
- Deduplicated rows.
- New rows added or dry-run candidates.
- Any network or parsing errors.
- Reminder to run `/career-ops pipeline` after saving new roles.
