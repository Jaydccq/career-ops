// IMPORTANT: CSS selectors are templates — refine after testing against live DOM
/**
 * extract-newgrad.ts — DOM parsers for newgrad-jobs.com pages.
 *
 * Two exported functions, each fully self-contained (no imports, no module
 * closures). They are designed to be passed directly to
 * chrome.scripting.executeScript({ func: ... }) from the background worker.
 *
 * Mode 1: extractNewGradList  — scrapes the job listing table
 * Mode 2: extractNewGradDetail — scrapes an individual job detail page
 */

/* ========================================================================== */
/*  Shared interfaces (compile-time only — stripped at runtime)               */
/* ========================================================================== */

export interface NewGradRow {
  position: number;
  title: string;
  postedAgo: string;
  applyUrl: string;
  detailUrl: string;
  workModel: string;
  location: string;
  company: string;
  salary: string;
  companySize: string;
  industry: string;
  qualifications: string;
  h1bSponsored: string;
  isNewGrad: string;
}

export interface NewGradDetail {
  position: number;
  title: string;
  company: string;
  location: string;
  employmentType: string;
  workModel: string;
  seniorityLevel: string;
  salaryRange: string;
  matchScore: number | null;
  expLevelMatch: number | null;
  skillMatch: number | null;
  industryExpMatch: number | null;
  description: string;
  originalPostUrl: string;
  applyNowUrl: string;
}

/* ========================================================================== */
/*  Mode 1 — List page extractor                                             */
/* ========================================================================== */

/**
 * Extracts all job rows from the newgrad-jobs.com listing table.
 * Must be completely self-contained for chrome.scripting.executeScript.
 */
export function extractNewGradList(): NewGradRow[] {
  /* ---- helpers (inlined — no closures) ---- */
  function txt(el: Element | null | undefined): string {
    if (!el) return "";
    return (
      (el as HTMLElement).innerText ?? el.textContent ?? ""
    ).trim();
  }

  function href(el: Element | null | undefined): string {
    if (!el) return "";
    return (el as HTMLAnchorElement).href ?? el.getAttribute("href") ?? "";
  }

  function first(parent: Element, ...selectors: string[]): Element | null {
    for (const sel of selectors) {
      const found = parent.querySelector(sel);
      if (found) return found;
    }
    return null;
  }

  function allCells(row: Element): Element[] {
    let cells = Array.from(row.querySelectorAll("td"));
    if (cells.length === 0)
      cells = Array.from(
        row.querySelectorAll("[class*='cell'], [class*='col'], [class*='field']")
      );
    return cells;
  }

  /* ---- locate rows ---- */
  let rows = Array.from(document.querySelectorAll("table tbody tr"));
  if (rows.length === 0) {
    rows = Array.from(
      document.querySelectorAll(
        "[class*='job-row'], [class*='listing-row'], [class*='job'] tr, [class*='listing'] tr"
      )
    );
  }
  if (rows.length === 0) {
    // Fallback: any repeated card-like structure with links
    rows = Array.from(
      document.querySelectorAll(
        "[class*='job-card'], [class*='job-item'], [class*='listing-item']"
      )
    );
  }

  const results: NewGradRow[] = [];

  for (const [i, row] of rows.entries()) {
    const cells = allCells(row);

    // Try to find an apply link anywhere in the row
    const applyLink = first(
      row,
      "a[href*='apply']",
      "a[href*='Apply']",
      "a[class*='apply']",
      "a[data-action*='apply']"
    );

    // Try to find the detail/title link (first internal link that is NOT the apply link)
    const allLinks = Array.from(row.querySelectorAll("a[href]"));
    const detailLink = allLinks.find(
      (a) =>
        a !== applyLink &&
        !href(a).toLowerCase().includes("apply") &&
        href(a).startsWith("/")
    ) ?? allLinks.find(
      (a) =>
        a !== applyLink &&
        !href(a).toLowerCase().includes("apply") &&
        href(a).includes("newgrad-jobs.com")
    ) ?? allLinks[0] ?? null;

    // Heuristic extraction: try cell-based first, fall back to row-level text
    const titleEl = first(
      row,
      "[class*='title']",
      "[class*='position']",
      "[data-field='title']",
      "a[href]:not([href*='apply'])"
    );

    const companyEl = first(
      row,
      "[class*='company']",
      "[data-field='company']"
    );

    const locationEl = first(
      row,
      "[class*='location']",
      "[data-field='location']"
    );

    const salaryEl = first(
      row,
      "[class*='salary']",
      "[class*='compensation']",
      "[data-field='salary']"
    );

    const postedEl = first(
      row,
      "[class*='posted']",
      "[class*='date']",
      "[class*='time']",
      "[data-field='posted']",
      "time"
    );

    const workModelEl = first(
      row,
      "[class*='work-model']",
      "[class*='remote']",
      "[class*='onsite']",
      "[class*='hybrid']",
      "[data-field='workModel']"
    );

    const companySizeEl = first(
      row,
      "[class*='size']",
      "[class*='company-size']",
      "[data-field='companySize']"
    );

    const industryEl = first(
      row,
      "[class*='industry']",
      "[data-field='industry']"
    );

    const qualsEl = first(
      row,
      "[class*='qual']",
      "[class*='requirement']",
      "[data-field='qualifications']"
    );

    const h1bEl = first(
      row,
      "[class*='h1b']",
      "[class*='sponsor']",
      "[class*='visa']",
      "[data-field='h1b']"
    );

    const newGradEl = first(
      row,
      "[class*='new-grad']",
      "[class*='newgrad']",
      "[class*='entry-level']",
      "[data-field='isNewGrad']"
    );

    // Build the row from element-based extraction. For cells that were not
    // found via class selectors, fall back to positional cell index. The
    // mapping below reflects the most common table layout on newgrad-jobs.com:
    //   0: title  1: posted  2: apply  3: workModel  4: location
    //   5: company  6: salary  7: companySize  8: industry  9: quals
    //   10: h1b  11: newGrad
    const titleText = txt(titleEl) || (cells[0] ? txt(cells[0]) : "");
    const postedText = txt(postedEl) || (cells[1] ? txt(cells[1]) : "");
    const workModelText = txt(workModelEl) || (cells[3] ? txt(cells[3]) : "");
    const locationText = txt(locationEl) || (cells[4] ? txt(cells[4]) : "");
    const companyText = txt(companyEl) || (cells[5] ? txt(cells[5]) : "");
    const salaryText = txt(salaryEl) || (cells[6] ? txt(cells[6]) : "");
    const companySizeText =
      txt(companySizeEl) || (cells[7] ? txt(cells[7]) : "");
    const industryText = txt(industryEl) || (cells[8] ? txt(cells[8]) : "");
    const qualsText = txt(qualsEl) || (cells[9] ? txt(cells[9]) : "");
    const h1bText = txt(h1bEl) || (cells[10] ? txt(cells[10]) : "");
    const newGradText = txt(newGradEl) || (cells[11] ? txt(cells[11]) : "");

    // Skip completely empty rows (header, separator, etc.)
    if (!titleText && !companyText) continue;

    results.push({
      position: i + 1,
      title: titleText,
      postedAgo: postedText,
      applyUrl: href(applyLink),
      detailUrl: href(detailLink),
      workModel: workModelText,
      location: locationText,
      company: companyText,
      salary: salaryText,
      companySize: companySizeText,
      industry: industryText,
      qualifications: qualsText.slice(0, 500),
      h1bSponsored: h1bText,
      isNewGrad: newGradText,
    });
  }

  return results;
}

/* ========================================================================== */
/*  Mode 2 — Detail page extractor                                           */
/* ========================================================================== */

/**
 * Extracts enriched job data from a newgrad-jobs.com detail page.
 * The `position` field is set to 0 here; the caller should override it
 * for correlation with the listing table.
 *
 * Must be completely self-contained for chrome.scripting.executeScript.
 */
export function extractNewGradDetail(): NewGradDetail {
  const MAX_DESC_CHARS = 20000;

  /* ---- helpers (inlined — no closures) ---- */
  function txt(el: Element | null | undefined): string {
    if (!el) return "";
    return (
      (el as HTMLElement).innerText ?? el.textContent ?? ""
    ).trim();
  }

  function href(el: Element | null | undefined): string {
    if (!el) return "";
    return (el as HTMLAnchorElement).href ?? el.getAttribute("href") ?? "";
  }

  function first(root: Document | Element, ...selectors: string[]): Element | null {
    for (const sel of selectors) {
      try {
        const found = root.querySelector(sel);
        if (found) return found;
      } catch {
        // Invalid selector — skip
      }
    }
    return null;
  }

  /**
   * Find a labelled value: given a label like "Location", search for a
   * DOM element whose text matches, then return the text of its next
   * sibling, parent's next sibling, or adjacent element.
   */
  function labelledValue(label: string): string {
    const allEls = Array.from(
      document.querySelectorAll(
        "dt, th, label, strong, b, [class*='label'], [class*='key'], [class*='field-name']"
      )
    );
    const lower = label.toLowerCase();
    for (const el of allEls) {
      const elText = txt(el).toLowerCase();
      if (elText.includes(lower)) {
        // Try next sibling element
        const next = el.nextElementSibling;
        if (next) {
          const val = txt(next);
          if (val) return val;
        }
        // Try parent's next sibling
        const parentNext = el.parentElement?.nextElementSibling;
        if (parentNext) {
          const val = txt(parentNext);
          if (val) return val;
        }
        // Try the text after the label within the same parent
        const parentText = txt(el.parentElement);
        const idx = parentText.toLowerCase().indexOf(lower);
        if (idx >= 0) {
          const afterLabel = parentText.slice(idx + label.length).replace(/^[:\s]+/, "").trim();
          if (afterLabel) return afterLabel;
        }
      }
    }
    return "";
  }

  /* ---- title ---- */
  const titleEl = first(
    document,
    "h1[class*='title']",
    "h1[class*='job']",
    "[class*='job-title']",
    "[class*='position-title']",
    "h1"
  );
  const title = txt(titleEl);

  /* ---- company ---- */
  const companyEl = first(
    document,
    "[class*='company-name']",
    "[class*='company'] h2",
    "[class*='company'] a",
    "[class*='employer']"
  );
  const company = txt(companyEl) || labelledValue("company");

  /* ---- location ---- */
  const locationEl = first(
    document,
    "[class*='location']",
    "[class*='job-location']"
  );
  const location = txt(locationEl) || labelledValue("location");

  /* ---- employment type ---- */
  const employmentType =
    labelledValue("employment type") ||
    labelledValue("job type") ||
    labelledValue("type");

  /* ---- work model ---- */
  const workModelEl = first(
    document,
    "[class*='work-model']",
    "[class*='remote']",
    "[class*='workplace']"
  );
  const workModel =
    txt(workModelEl) ||
    labelledValue("work model") ||
    labelledValue("workplace type") ||
    labelledValue("remote");

  /* ---- seniority level ---- */
  const seniorityLevel =
    labelledValue("seniority") ||
    labelledValue("experience level") ||
    labelledValue("level");

  /* ---- salary range ---- */
  const salaryEl = first(
    document,
    "[class*='salary']",
    "[class*='compensation']",
    "[class*='pay']"
  );
  const salaryRange =
    txt(salaryEl) ||
    labelledValue("salary") ||
    labelledValue("compensation") ||
    labelledValue("pay range");

  /* ---- Jobright match scores ---- */
  const bodyText = document.body?.innerText ?? "";

  function extractPercentage(pattern: RegExp): number | null {
    const m = bodyText.match(pattern);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }

  // Overall match: "85% GOOD MATCH" or "92% GREAT MATCH"
  const matchScore = extractPercentage(
    /(\d+)\s*%\s*(?:GOOD\s+MATCH|GREAT\s+MATCH|MATCH)/i
  );

  // Sub-scores: "Experience Level Match 80%" or "Experience Level: 80%"
  const expLevelMatch = extractPercentage(
    /experience\s+level\s*(?:match)?\s*[:\s]*(\d+)\s*%/i
  );

  // "Skill Match 75%" or "Skills: 75%"
  const skillMatch = extractPercentage(
    /skills?\s*(?:match)?\s*[:\s]*(\d+)\s*%/i
  );

  // "Industry Experience Match 60%"
  const industryExpMatch = extractPercentage(
    /industry\s*(?:experience)?\s*(?:match)?\s*[:\s]*(\d+)\s*%/i
  );

  /* ---- description ---- */
  const descEl = first(
    document,
    "[class*='description']",
    "[class*='job-details']",
    "[class*='job-body']",
    "[class*='jd-content']",
    "article",
    "main [class*='content']",
    "main"
  );
  const rawDesc = txt(descEl) || txt(document.querySelector("main")) || "";
  const description = rawDesc
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, MAX_DESC_CHARS);

  /* ---- original post URL ---- */
  const origLink = first(
    document,
    "a[href*='original']",
    "a[class*='original']"
  );
  let originalPostUrl = href(origLink);
  if (!originalPostUrl) {
    // Search link text for "Original Job Post" or similar
    const allLinks = Array.from(document.querySelectorAll("a[href]"));
    for (const a of allLinks) {
      const linkText = txt(a).toLowerCase();
      if (
        linkText.includes("original") &&
        (linkText.includes("post") || linkText.includes("job"))
      ) {
        originalPostUrl = href(a);
        break;
      }
    }
  }

  /* ---- apply now URL ---- */
  const applyLink = first(
    document,
    "a[href*='apply'][class*='btn']",
    "a[href*='apply'][class*='button']",
    "a[href*='apply']",
    "button[class*='apply']",
    "[class*='apply'] a",
    "a[class*='apply']"
  );
  let applyNowUrl = href(applyLink);
  if (!applyNowUrl) {
    const allLinks = Array.from(document.querySelectorAll("a[href]"));
    for (const a of allLinks) {
      const linkText = txt(a).toLowerCase();
      if (linkText.includes("apply now") || linkText.includes("apply for")) {
        applyNowUrl = href(a);
        break;
      }
    }
  }

  return {
    position: 0,
    title,
    company,
    location,
    employmentType,
    workModel,
    seniorityLevel,
    salaryRange,
    matchScore,
    expLevelMatch,
    skillMatch,
    industryExpMatch,
    description,
    originalPostUrl,
    applyNowUrl,
  };
}
