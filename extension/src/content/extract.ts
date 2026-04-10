/**
 * extract.ts — heuristic job-page detection and DOM text extraction.
 *
 * Called by chrome.scripting.executeScript from the background service
 * worker. Pure DOM — no network, no storage, no extension APIs.
 *
 * Detection is deliberately lightweight. The popup asks the user to
 * confirm before evaluating, so false positives are cheap. The heuristic
 * favors "yes this is a job posting" signals over strict exclusion.
 */

/**
 * When injected via chrome.scripting.executeScript({ files: ["content.js"] }),
 * this file runs as a self-contained IIFE in the page context. All
 * dependencies must be inlined — no imports from other modules.
 *
 * The result is returned via the script's return value, which Chrome
 * surfaces as results[0].result in the background worker.
 */

interface PageDetection {
  label: "job_posting" | "likely_job_posting" | "not_job_posting";
  confidence: number;
  signals: readonly string[];
}

interface CapturedTab {
  tabId: number;
  url: string;
  title: string;
  pageText: string;
  detection: PageDetection;
  capturedAt: string;
}

const EXTRACT_MAX_CHARS = 20_000;

const POSITIVE_KEYWORDS: readonly string[] = [
  "responsibilities",
  "requirements",
  "qualifications",
  "about the role",
  "about this role",
  "we're looking for",
  "what you'll do",
  "what you will do",
  "what we're looking for",
  "nice to have",
  "apply for this job",
  "apply now",
  "submit application",
  "years of experience",
];

const JOB_BOARD_HOSTS: readonly string[] = [
  "boards.greenhouse.io",
  "jobs.ashbyhq.com",
  "jobs.lever.co",
  "wellfound.com",
  "angel.co",
  "linkedin.com",
  "workable.com",
  "jobs.smartrecruiters.com",
  "workday",
  "remote.com",
  "remotefront",
];

function scoreText(text: string): { hits: string[]; score: number } {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  let score = 0;
  for (const kw of POSITIVE_KEYWORDS) {
    if (lower.includes(kw)) {
      hits.push(`keyword:${kw}`);
      score += 1;
    }
  }
  return { hits, score };
}

function scoreHost(host: string): { hits: string[]; score: number } {
  const lower = host.toLowerCase();
  const hits: string[] = [];
  let score = 0;
  for (const h of JOB_BOARD_HOSTS) {
    if (lower.includes(h)) {
      hits.push(`host:${h}`);
      score += 3; // host is a strong signal
      break;
    }
  }
  return { hits, score };
}

function detect(host: string, text: string): PageDetection {
  const textResult = scoreText(text);
  const hostResult = scoreHost(host);
  const total = textResult.score + hostResult.score;
  const signals = [...hostResult.hits, ...textResult.hits];

  let label: PageDetection["label"];
  let confidence: number;
  if (total >= 6) {
    label = "job_posting";
    confidence = Math.min(0.95, 0.5 + total * 0.05);
  } else if (total >= 2) {
    label = "likely_job_posting";
    confidence = Math.min(0.75, 0.3 + total * 0.05);
  } else {
    label = "not_job_posting";
    confidence = Math.max(0.1, 0.3 - total * 0.05);
  }

  return { label, confidence, signals };
}

function extractBodyText(doc: Document): string {
  // Prefer <main>, then <article>, then <body>.
  const main =
    doc.querySelector("main") ??
    doc.querySelector("article") ??
    doc.body;
  if (!main) return "";
  // innerText respects visibility; textContent does not. innerText is
  // exactly what we want for JD extraction.
  const raw = (main as HTMLElement).innerText ?? main.textContent ?? "";
  const compacted = raw.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  return compacted.slice(0, EXTRACT_MAX_CHARS);
}

/**
 * Self-executing capture. When this file is injected via
 * chrome.scripting.executeScript({ files: ["content.js"] }),
 * Chrome uses the last expression's value as results[0].result.
 */
(() => {
  const url = location.href;
  const title = document.title;
  const pageText = extractBodyText(document);
  const detection = detect(location.hostname, pageText);
  const result: CapturedTab = {
    tabId: -1, // filled by background after return
    url,
    title,
    pageText,
    detection,
    capturedAt: new Date().toISOString(),
  };
  return result;
})();
