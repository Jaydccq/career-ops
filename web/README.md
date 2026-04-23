# Career-Ops Dashboard

A local dashboard for browsing reports, tracker, pipeline, and scan history.
It is served from this repository so Apply Next actions can reuse the local
Node/Playwright PDF generators.

## Usage

```bash
npm run dashboard       # start local dashboard server
```

Then open the printed local URL, usually `http://127.0.0.1:47329/`.

## What it shows

| Tab           | Source                       | Features                                   |
|---------------|------------------------------|--------------------------------------------|
| Apply Next    | `data/applications.md` + `reports/*.md` | Priority shortlist, selective shortlist, local completion marks |
| Reports       | `reports/*.md`               | Filter, select, render Markdown in panel   |
| Tracker       | `data/applications.md`       | Filter, status dropdown, sortable columns  |
| Pipeline      | `data/pipeline.md`           | Filter, done/pending toggle                |
| Scan History  | `data/scan-history.tsv`      | Filter, portal dropdown, sortable columns  |
| Keywords      | `data/newgrad-skill-stats.json` | Last-scan and profile matched/missed skill coverage |

## How it works

1. `dashboard-server.mjs` serves `template.html` with fresh data from the repo.
2. `build-dashboard.mjs` provides the shared parser/renderer for tracker,
   reports, pipeline, scan history, and keyword stats.
3. Apply Next PDF buttons call the local server, which reuses
   `generate-pdf.mjs` and `generate-cover-letter.mjs`, creates PDFs under
   `output/`, and copies them into `~/Downloads` when the download button is
   clicked.

The `Apply Next` tab also stores a local completion marker in browser
`localStorage`. That marker is a dashboard convenience only; canonical tracker
state still lives in `data/applications.md`.

Report Markdown is rendered client-side with [marked](https://marked.js.org/)
and sanitised through [DOMPurify](https://github.com/cure53/DOMPurify).

## Static Export

To write a standalone `web/index.html` snapshot:

```bash
npm run dashboard:build
```

Run it after:

- new evaluation reports (reports/*.md)
- `node merge-tracker.mjs` runs (applications.md updates)
- scanner runs (scan-history.tsv updates)

The static snapshot can still browse embedded data, but PDF generation requires
the local dashboard server.
