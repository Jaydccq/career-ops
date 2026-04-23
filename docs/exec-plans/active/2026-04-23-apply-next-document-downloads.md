# Apply Next Document Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-role Apply Next controls that generate a CV draft and cover-letter draft, then expose download buttons from the static dashboard.

**Architecture:** Keep the dashboard static and browser-only. Extend `web/build-dashboard.mjs` to inline the canonical `cv.md`, then extend `web/template.html` so each Apply Next card can generate job-specific Markdown drafts from the tracker row, matching report, and base CV data.

**Tech Stack:** Static HTML, vanilla JavaScript, browser Blob downloads, Node dashboard builder.

---

## Background

The dashboard is generated from `web/template.html` by `web/build-dashboard.mjs`
and written to `web/index.html`. Apply Next currently renders links to the job,
the dossier, and a local "mark applied" control.

## Goal

Users should be able to click Apply Next buttons for each recommended role:

1. Generate CV draft.
   Verify: the card reveals a CV download button.
2. Generate cover-letter draft.
   Verify: the card reveals a cover-letter download button.
3. Download each generated document.
   Verify: the browser download event uses a deterministic filename.

## Scope

- Modify `web/build-dashboard.mjs` to include the source CV markdown.
- Modify `web/template.html` to add generation and download controls.
- Regenerate `web/index.html` with `npm run dashboard`.
- Do not change existing PDF generation modes or application tracker rows.
- Do not claim that the static page can silently write to `~/Downloads`; browser
  downloads use the user's configured download folder.

## Assumptions

- The user's `index.html` means `web/index.html`, because there is no root
  `index.html` and the docs identify `web/index.html` as the dashboard.
- Static HTML cannot run the repository's Node/Playwright PDF scripts directly.
- Markdown drafts are the simplest viable output because they are transparent,
  editable, and can be generated fully in the browser.
- Existing report content has enough fit and tailoring context to produce useful
  cover-letter and CV tailoring drafts without inventing experience.

## Success Criteria

- Apply Next cards show `Generate CV` and `Generate Cover Letter` buttons.
- Clicking either generate button creates an in-memory document and reveals a
  corresponding download button on that card.
- Download filenames include document type, company, role, and date.
- `npm run dashboard` completes and updates `web/index.html`.
- Browser verification confirms the buttons render, generation reveals download
  controls, and the download event fires.

## Implementation Steps

- [x] **Step 1: Preserve existing generated dashboard flow**
  - Inspect `web/template.html`, `web/build-dashboard.mjs`, and the current
    `web/index.html` diff.
  - Verify: `web/index.html` is generated from current repo data and should be
    regenerated after template changes.

- [x] **Step 2: Inline base CV data**
  - Add `cvMarkdown: readOr(join(ROOT, 'cv.md'))` to the data object in
    `web/build-dashboard.mjs`.
  - Verify: generated `window.DATA` contains a `cvMarkdown` string.

- [x] **Step 3: Add Apply Next document controls**
  - Add action buttons to `renderApplyCard`.
  - Add client-side helpers for slugging filenames, extracting report sections,
    building CV markdown, building cover-letter markdown, storing generated
    documents, and triggering Blob downloads.
  - Verify: each card has generate buttons and hidden download controls until
    generation happens.

- [x] **Step 4: Regenerate dashboard**
  - Run `npm run dashboard`.
  - Verify: command exits successfully and writes `web/index.html`.

- [x] **Step 5: Browser smoke test**
  - Open `web/index.html` with Playwright from `file://`.
  - Click `Generate CV` and `Generate Cover Letter` on the first Apply Next card.
  - Click both download buttons.
  - Verify: download events fire and filenames are deterministic.

## Verification Approach

- `npm run dashboard`
- Node/Playwright smoke test against `file:///Users/hongxichen/Desktop/career-ops/web/index.html`
- `git diff --check -- web/build-dashboard.mjs web/template.html web/index.html docs/exec-plans/active/2026-04-23-apply-next-document-downloads.md`

## Progress Log

- 2026-04-23: Read `CLAUDE.md`, the dashboard template, builder, and existing
  Apply Next rendering. Confirmed setup files exist and update check is current.
- 2026-04-23: Created this execution plan before editing implementation files.
- 2026-04-23: Added `cvMarkdown` to generated dashboard data, then added
  browser-side CV and cover-letter Markdown draft generation to Apply Next
  cards.
- 2026-04-23: Regenerated `web/index.html` with `npm run dashboard`.
- 2026-04-23: Verified template script parsing, diff whitespace, button
  presence, and Playwright download smoke behavior.
- 2026-04-23: Playwright confirmed generated filenames:
  `cv-gumloop-software-engineer-2026-04-23.md` and
  `cover-letter-gumloop-software-engineer-2026-04-23.md`.

## Key Decisions

- Use browser downloads instead of attempting direct filesystem writes, because
  direct silent writes to `~/Downloads` are blocked by browser security.
- Generate Markdown drafts rather than fake PDFs, because PDF generation in this
  repo depends on agent-authored HTML/JSON plus Node/Playwright scripts.
- Change the template and builder, then regenerate `web/index.html`, instead of
  editing the generated dashboard only.

## Risks and Blockers

- Download location depends on the user's browser settings. Most browsers save
  to `Downloads`, but a user-configured alternate folder can override that.
- Generated drafts are deterministic dashboard drafts, not a replacement for
  the richer agent-driven `/career-ops pdf` and `/career-ops cover-letter`
  workflows.

## Final Outcome

Apply Next now includes per-role `Generate CV` and `Generate Cover Letter`
buttons. Each generation action creates an in-memory Markdown draft and reveals
the matching `Download CV` or `Download Cover Letter` button. Browser download
events were verified from the generated `web/index.html`.
