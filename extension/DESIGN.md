# career-ops Extension — Design System

## Aesthetic Direction

Signal Desk UI. The extension should feel like a compact task-control surface:
sharp, readable, slightly editorial, and built for quick judgment inside a
crowded browser page. It keeps a dark overlay base for host-page contrast, but
uses brighter signal colors, stronger section rhythm, and fewer generic stacked
card cues than the earlier industrial dark panel.

## Color Tokens

| Token             | Value     | Usage                             |
|-------------------|-----------|-----------------------------------|
| `--bg`            | `#10120f` | Panel background                  |
| `--surface`       | `#171915` | Main functional sections          |
| `--surface-raised`| `#1f231d` | Hover and raised controls         |
| `--surface-soft`  | `#151713` | Status strips and nested controls |
| `--field`         | `#0b0d0b` | Inputs and code blocks            |
| `--text`          | `#eef2ea` | Primary text                      |
| `--muted`         | `#a3ad9e` | Secondary text and metadata       |
| `--dim`           | `#6f796a` | Labels and tertiary text          |
| `--border`        | `#32382f` | Section and row dividers          |
| `--border-strong` | `#4a5345` | Outer panel and strong controls   |
| `--accent`        | `#37d7d2` | Primary CTA, active scanner state |
| `--accent-strong` | `#8df0ed` | Hover accent                      |
| `--lime`          | `#c8f05a` | Brand kicker and high-signal tags |
| `--ok`            | `#62d883` | Success, healthy, completed       |
| `--warn`          | `#efc75e` | Warnings, caution                 |
| `--err`           | `#ff7668` | Errors, failures                  |

## Surface Tiers

| Tier       | Background          | Border                         | Usage                          |
|------------|---------------------|--------------------------------|--------------------------------|
| Chrome     | `--surface`         | bottom divider                 | Header, health chip, close     |
| Section    | `--surface`         | `1px solid var(--border)`      | Capture, mode, scanner blocks  |
| Nested     | `--surface-soft`    | `1px solid var(--border)`      | Status strips, keyword cards   |
| Field      | `--field`           | `1px solid var(--border)`      | Inputs, code, commands         |

## Spacing Scale (4px base)

`--sp-1` (4px), `--sp-2` (8px), `--sp-3` (12px), `--sp-4` (16px), `--sp-5` (20px), `--sp-6` (24px)

## Type Scale

| Token          | Size  | Usage                                |
|----------------|-------|--------------------------------------|
| `--fs-caption` | 10px  | Footer, section labels, source meta |
| `--fs-small`   | 11px  | Metadata, URLs, hints, mono content |
| `--fs-body`    | 13px  | Primary body text, buttons          |
| `--fs-title`   | 14px  | Panel title                         |
| `--fs-score`   | 30px  | Score hero in evaluation result     |

## Font Stacks

- **Sans:** `"Aptos", "Fira Sans", "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **Mono:** `"Fira Code", "SFMono-Regular", ui-monospace, Menlo, monospace`

## Border Radii

- `--r-sm` (4px): Buttons, inputs, inline code, row hover
- `--r-md` (8px): Panel shell and functional sections
- `999px`: Health and source badges only

## Interaction Patterns

### Bridge Chip
Status indicator in header. Shows health dot + label. Click toggles a compact
bridge summary that only states the current mode. Uses `aria-expanded` /
`aria-controls`.

### Stepper (Progress)
Vertical list with `::before` icons: `○` pending, `●` active (pulsing),
`✓` completed, `✕` failed. Phase counter below: "Phase X of Y".

### Inline Expiry Warning
Replaces native `confirm()`. Amber-tinted panel inside the capture section
with warning text + "Evaluate anyway" / "Cancel" buttons.

### Contextual Errors
Error classification by keyword matching: connection, timeout, auth, rate limit.
Each category shows a human-readable explanation and structured recovery hint
with optional inline `<code>` snippet. DOM-constructed, never innerHTML.

### Recent Evaluations
Scrollable with `max-height: 240px`. Fade mask at bottom when overflowing
(via `::after` sticky gradient). Each row: `role="button"`, `tabindex="0"`,
Enter/Space keyboard handler.

### Scanner Surface
Scanner pages use one workflow section rather than several unrelated cards:
source title, status strip, optional source search card, primary scan CTA,
results, pending candidates, and evaluation progress. Built In keyword search
uses a nested source card with a source badge, all-location meta label, keyword
input, shortcut chips, and concise helper text.

## Accessibility

- `aria-live="polite"` on health status and phase list
- `aria-live="assertive"` on evaluation result score
- `.sr-only` class for screen-reader-only text
- `:focus-visible` outlines on all interactive elements
- Button padding targets compact desktop use while preserving visible focus and
  cursor affordance
- `role="alert"` on offline banner and error section

## Score Color Thresholds

Defined in `src/shared/utils.ts` — `scoreColor()`:
- >= 4.0: `#4ecb71` (green)
- >= 2.5: `#e5b93c` (amber)
- < 2.5:  `#ef5f5f` (red)
