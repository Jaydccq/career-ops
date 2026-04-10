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

import type {
  CapturedTab,
  EXTRACT_MAX_CHARS as _EXTRACT_MAX_CHARS_,
} from "../contracts/messages.js";
import type { PageDetection } from "../contracts/bridge-wire.js";

// Repeat the literal to avoid pulling the runtime const from messages.ts
// into the content script bundle. Content scripts run in the page world
// and should stay small.
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
 * Extract a CapturedTab from the current document. Called via
 * chrome.scripting.executeScript from the background worker.
 *
 * `tabId` is injected by the caller, not obtained here.
 */
export function capturePage(tabId: number): CapturedTab {
  const url = location.href;
  const title = document.title;
  const pageText = extractBodyText(document);
  const detection = detect(location.hostname, pageText);
  return {
    tabId,
    url,
    title,
    pageText,
    detection,
    capturedAt: new Date().toISOString(),
  };
}

// Hint: the unused import exists only so the compiler verifies the name
// still lives in the shared messages.ts contract.
void (0 as unknown as typeof _EXTRACT_MAX_CHARS_);
