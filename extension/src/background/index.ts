/**
 * index.ts — background service worker entrypoint.
 *
 * Responsibilities:
 *   • Route PopupRequest messages from the popup.
 *   • Capture the active tab via chrome.scripting.executeScript.
 *   • Proxy bridge HTTP calls.
 *   • Maintain SSE subscriptions and re-fan events to popup ports.
 *
 * MV3 note: this is a service worker, not a persistent background page.
 * It may be killed and restarted at any time. All mutable state must
 * live either in chrome.storage or be recoverable on restart.
 *
 * The one exception: active SSE subscriptions are held in a module-level
 * Map. If the worker is evicted, the SSE stream terminates and the popup
 * must resubscribe. That is acceptable for Phase 2 — popups live for
 * seconds, not hours.
 */

import type {
  CapturedTab,
  ExtensionState,
  JobPortMessage,
  PopupRequest,
  PopupResponse,
} from "../contracts/messages.js";
import type {
  BridgeError,
  EnrichedRow,
  JobEvent,
  JobId,
  NewGradDetail,
  NewGradRow,
  ScoredRow,
} from "../contracts/bridge-wire.js";

import { loadState, patchState } from "./state.js";
import { bridgeClientFromState } from "./bridge-client.js";

/* -------------------------------------------------------------------------- */
/*  Subscription registry                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Open SSE streams keyed by jobId. An entry exists while the stream is
 * running; the AbortController tears it down. One stream per job; multiple
 * ports may share a stream (e.g. popup reopened while job still running).
 */
interface Subscription {
  controller: AbortController;
  ports: Set<chrome.runtime.Port>;
}
const subscriptions = new Map<JobId, Subscription>();

/* -------------------------------------------------------------------------- */
/*  Toolbar icon click → toggle panel in active tab                           */
/* -------------------------------------------------------------------------- */

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { kind: "togglePanel" });
  } catch {
    // Content script not yet loaded — inject it first, then toggle
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["panel.js"],
      });
      // Give it a moment to register the listener
      setTimeout(() => {
        if (tab.id) chrome.tabs.sendMessage(tab.id, { kind: "togglePanel" });
      }, 100);
    } catch {
      // Can't inject (chrome:// page, etc.) — ignore
    }
  }
});

/* -------------------------------------------------------------------------- */
/*  Message router                                                            */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener(
  (rawMessage, _sender, sendResponse) => {
    void handleRequest(rawMessage as PopupRequest).then(sendResponse);
    return true; // keep the message channel open for async
  }
);

async function handleRequest(req: PopupRequest): Promise<PopupResponse> {
  try {
    switch (req.kind) {
      case "hasToken":
        return await handleHasToken();
      case "setToken":
        return await handleSetToken(req.token);
      case "getModePreference":
        return await handleGetModePreference();
      case "setModePreference":
        return await handleSetModePreference(req.preset);
      case "getHealth":
        return await handleGetHealth();
      case "captureActiveTab":
        return await handleCapture();
      case "checkLiveness":
        return await handleLiveness(req.url);
      case "startEvaluation":
        return await handleStartEvaluation(req.input);
      case "subscribeJob":
        return handleSubscribeAck(req.jobId);
      case "unsubscribeJob":
        return handleUnsubscribeAck(req.jobId);
      case "openPath":
        return await handleOpenPath(req.absolutePath);
      case "getRecentJobs":
        return await handleGetRecentJobs(req.limit);
      case "readReport":
        return await handleReadReport(req.reportNum);
      case "mergeTracker":
        return await handleMergeTracker(req.dryRun);
      case "newgradExtractList":
        return await handleNewGradExtractList();
      case "newgradScore":
        return await handleNewGradScore(req.rows);
      case "newgradEnrichDetails":
        return await handleNewGradEnrichDetails(req.promotedRows, req.config);
      case "newgradEnrich":
        return await handleNewGradEnrich(req.rows);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Narrow return type to a failure envelope matching the request kind.
    const bridgeErr: BridgeError = { code: "INTERNAL", message };
    return failureFor(req, bridgeErr);
  }
}

function failureFor(req: PopupRequest, error: BridgeError): PopupResponse {
  // Every PopupResponse variant has `{ kind, ok: false, error }`.
  return { kind: req.kind, ok: false, error } as PopupResponse;
}

/* -------------------------------------------------------------------------- */
/*  Handlers                                                                  */
/* -------------------------------------------------------------------------- */

async function handleHasToken(): Promise<PopupResponse> {
  const state = await loadState();
  return {
    kind: "hasToken",
    ok: true,
    result: { present: state.bridgeToken.length > 0 },
  };
}

async function handleSetToken(token: string): Promise<PopupResponse> {
  const trimmed = token.trim();
  if (trimmed.length < 16) {
    return {
      kind: "setToken",
      ok: false,
      error: { code: "BAD_REQUEST", message: "token too short" },
    };
  }
  await patchState({ bridgeToken: trimmed });
  return { kind: "setToken", ok: true, result: { saved: true } };
}

async function handleGetModePreference(): Promise<PopupResponse> {
  const state = await loadState();
  return {
    kind: "getModePreference",
    ok: true,
    result: { preset: state.preferredBridgePreset },
  };
}

async function handleSetModePreference(
  preset: import("../contracts/messages.js").BridgePreset
): Promise<PopupResponse> {
  const next = await patchState({ preferredBridgePreset: preset });
  return {
    kind: "setModePreference",
    ok: true,
    result: { saved: true, preset: next.preferredBridgePreset },
  };
}

async function handleGetHealth(): Promise<PopupResponse> {
  const state = await loadState();
  if (!state.bridgeToken) {
    return {
      kind: "getHealth",
      ok: false,
      error: { code: "UNAUTHORIZED", message: "bridge token not configured" },
    };
  }
  const client = bridgeClientFromState(state);
  const res = await client.getHealth();
  await patchState({
    lastHealthAt: new Date().toISOString(),
    lastHealthOk: res.ok,
  });
  if (res.ok) return { kind: "getHealth", ok: true, result: res.result };
  return { kind: "getHealth", ok: false, error: res.error };
}

async function handleCapture(): Promise<PopupResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined || !tab.url) {
    return {
      kind: "captureActiveTab",
      ok: false,
      error: { code: "NOT_FOUND", message: "no active tab" },
    };
  }
  // Refuse chrome://, about:, etc. — scripting API cannot inject there
  // and even if it could, there's no JD to extract.
  if (!/^https?:\/\//.test(tab.url)) {
    return {
      kind: "captureActiveTab",
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message: `cannot capture non-http page: ${tab.url}`,
      },
    };
  }
  const tabId = tab.id;
  // The injected function must be FULLY self-contained — every constant,
  // helper, and type must live inside the function body. chrome.scripting
  // serializes only this function; module-level closures do not travel.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const EXTRACT_MAX_CHARS = 20000;
      const POSITIVE_KEYWORDS = [
        "responsibilities", "requirements", "qualifications",
        "about the role", "about this role", "we're looking for",
        "what you'll do", "what you will do", "what we're looking for",
        "nice to have", "apply for this job", "apply now",
        "submit application", "years of experience",
      ];
      const JOB_BOARD_HOSTS = [
        "boards.greenhouse.io", "jobs.ashbyhq.com", "jobs.lever.co",
        "wellfound.com", "angel.co", "linkedin.com", "workable.com",
        "jobs.smartrecruiters.com", "workday", "remote.com", "remotefront",
        "fujitsu.com", "icims.com", "myworkdayjobs.com",
      ];

      const lower = (document.body?.innerText ?? "").toLowerCase();
      const hits: string[] = [];
      let score = 0;
      for (const kw of POSITIVE_KEYWORDS) {
        if (lower.includes(kw)) { hits.push("keyword:" + kw); score += 1; }
      }
      const host = location.hostname.toLowerCase();
      for (const h of JOB_BOARD_HOSTS) {
        if (host.includes(h)) { hits.push("host:" + h); score += 3; break; }
      }

      let label: "job_posting" | "likely_job_posting" | "not_job_posting";
      let confidence: number;
      if (score >= 6) { label = "job_posting"; confidence = Math.min(0.95, 0.5 + score * 0.05); }
      else if (score >= 2) { label = "likely_job_posting"; confidence = Math.min(0.75, 0.3 + score * 0.05); }
      else { label = "not_job_posting"; confidence = Math.max(0.1, 0.3 - score * 0.05); }

      const main = document.querySelector("main")
        ?? document.querySelector("article")
        ?? document.body;
      const rawText = (main as HTMLElement)?.innerText ?? "";
      const pageText = rawText.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, EXTRACT_MAX_CHARS);

      return {
        tabId: -1,
        url: location.href,
        title: document.title,
        pageText,
        detection: { label, confidence, signals: hits },
        capturedAt: new Date().toISOString(),
      };
    },
  });
  const rawResult = results[0]?.result as CapturedTab | undefined;
  const captured = rawResult ? { ...rawResult, tabId } : undefined;
  if (!captured) {
    return {
      kind: "captureActiveTab",
      ok: false,
      error: {
        code: "INTERNAL",
        message: "content script returned no result",
      },
    };
  }
  return { kind: "captureActiveTab", ok: true, result: captured };
}

async function handleLiveness(url: string): Promise<PopupResponse> {
  const state = await loadState();
  const client = bridgeClientFromState(state);
  const res = await client.checkLiveness(url);
  if (res.ok) return { kind: "checkLiveness", ok: true, result: res.result };
  return { kind: "checkLiveness", ok: false, error: res.error };
}

async function handleStartEvaluation(
  input: import("../contracts/bridge-wire.js").EvaluationInput
): Promise<PopupResponse> {
  const state = await loadState();
  const client = bridgeClientFromState(state);
  const res = await client.createEvaluation(input);
  if (!res.ok) {
    return { kind: "startEvaluation", ok: false, error: res.error };
  }
  const { jobId } = res.result;

  // Persist last-job for popup reopen.
  await patchState({ lastJobId: jobId });

  // Kick off the SSE stream immediately so we don't lose events between
  // POST and the popup's subscribe call.
  openStream(jobId, state);

  // Build a minimal initial snapshot for the popup to render while it
  // waits for the first real SSE event. The bridge's initial SSE frame
  // will overwrite this.
  const now = new Date().toISOString();
  const initialSnapshot: import("../contracts/bridge-wire.js").JobSnapshot = {
    id: jobId,
    phase: "queued",
    createdAt: now,
    updatedAt: now,
    input,
    progress: { phases: [{ phase: "queued", at: now }] },
  };

  return {
    kind: "startEvaluation",
    ok: true,
    result: { jobId, initialSnapshot },
  };
}

function handleSubscribeAck(_jobId: JobId): PopupResponse {
  // Actual subscription happens via chrome.runtime.connect, not onMessage.
  // This message exists for symmetry; we just ack it.
  void _jobId;
  return { kind: "subscribeJob", ok: true, result: { subscribed: true } };
}

function handleUnsubscribeAck(_jobId: JobId): PopupResponse {
  void _jobId;
  return {
    kind: "unsubscribeJob",
    ok: true,
    result: { unsubscribed: true },
  };
}

async function handleOpenPath(absolutePath: string): Promise<PopupResponse> {
  // file:// URLs may require the user to explicitly grant access; we
  // open them in a new tab and let Chrome handle access. In Phase 2
  // we don't try to pre-flight that.
  try {
    await chrome.tabs.create({ url: `file://${absolutePath}` });
    return { kind: "openPath", ok: true, result: { opened: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "openPath",
      ok: false,
      error: { code: "INTERNAL", message },
    };
  }
}

async function handleGetRecentJobs(limit?: number): Promise<PopupResponse> {
  const state = await loadState();
  if (!state.bridgeToken) {
    return {
      kind: "getRecentJobs",
      ok: false,
      error: { code: "UNAUTHORIZED", message: "bridge token not configured" },
    };
  }
  const client = bridgeClientFromState(state);
  const res = await client.getTracker(limit ?? 20);
  if (res.ok) return { kind: "getRecentJobs", ok: true, result: res.result };
  return { kind: "getRecentJobs", ok: false, error: res.error };
}

async function handleReadReport(reportNum: number): Promise<PopupResponse> {
  const state = await loadState();
  if (!state.bridgeToken) {
    return {
      kind: "readReport",
      ok: false,
      error: { code: "UNAUTHORIZED", message: "bridge token not configured" },
    };
  }
  const client = bridgeClientFromState(state);
  const res = await client.getReport(reportNum);
  if (res.ok) return { kind: "readReport", ok: true, result: res.result };
  return { kind: "readReport", ok: false, error: res.error };
}

async function handleMergeTracker(dryRun?: boolean): Promise<PopupResponse> {
  const state = await loadState();
  if (!state.bridgeToken) {
    return {
      kind: "mergeTracker",
      ok: false,
      error: { code: "UNAUTHORIZED", message: "bridge token not configured" },
    };
  }
  const client = bridgeClientFromState(state);
  const res = await client.mergeTracker(dryRun ?? false);
  if (res.ok) return { kind: "mergeTracker", ok: true, result: res.result };
  return { kind: "mergeTracker", ok: false, error: res.error };
}

/* -------------------------------------------------------------------------- */
/*  Newgrad-scan handlers                                                     */
/* -------------------------------------------------------------------------- */

async function handleNewGradExtractList(): Promise<PopupResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined || !tab.url) {
    return {
      kind: "newgradExtractList",
      ok: false,
      error: { code: "NOT_FOUND", message: "no active tab" },
    };
  }
  if (!tab.url.includes("newgrad-jobs.com")) {
    return {
      kind: "newgradExtractList",
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message: `active tab is not on newgrad-jobs.com: ${tab.url}`,
      },
    };
  }
  const tabId = tab.id;

  // The injected function must be FULLY self-contained — every constant,
  // helper, and type must live inside the function body. chrome.scripting
  // serializes only this function; module-level closures do not travel.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
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
        rows = Array.from(
          document.querySelectorAll(
            "[class*='job-card'], [class*='job-item'], [class*='listing-item']"
          )
        );
      }

      const results: {
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
      }[] = [];

      for (const [i, row] of rows.entries()) {
        const cells = allCells(row);

        const applyLink = first(
          row,
          "a[href*='apply']",
          "a[href*='Apply']",
          "a[class*='apply']",
          "a[data-action*='apply']"
        );

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

        const titleEl = first(
          row,
          "[class*='title']",
          "[class*='position']",
          "[data-field='title']",
          "a[href]:not([href*='apply'])"
        );

        const companyEl = first(row, "[class*='company']", "[data-field='company']");
        const locationEl = first(row, "[class*='location']", "[data-field='location']");
        const salaryEl = first(row, "[class*='salary']", "[class*='compensation']", "[data-field='salary']");
        const postedEl = first(row, "[class*='posted']", "[class*='date']", "[class*='time']", "[data-field='posted']", "time");
        const workModelEl = first(row, "[class*='work-model']", "[class*='remote']", "[class*='onsite']", "[class*='hybrid']", "[data-field='workModel']");
        const companySizeEl = first(row, "[class*='size']", "[class*='company-size']", "[data-field='companySize']");
        const industryEl = first(row, "[class*='industry']", "[data-field='industry']");
        const qualsEl = first(row, "[class*='qual']", "[class*='requirement']", "[data-field='qualifications']");
        const h1bEl = first(row, "[class*='h1b']", "[class*='sponsor']", "[class*='visa']", "[data-field='h1b']");
        const newGradEl = first(row, "[class*='new-grad']", "[class*='newgrad']", "[class*='entry-level']", "[data-field='isNewGrad']");

        const titleText = txt(titleEl) || (cells[0] ? txt(cells[0]) : "");
        const postedText = txt(postedEl) || (cells[1] ? txt(cells[1]) : "");
        const workModelText = txt(workModelEl) || (cells[3] ? txt(cells[3]) : "");
        const locationText = txt(locationEl) || (cells[4] ? txt(cells[4]) : "");
        const companyText = txt(companyEl) || (cells[5] ? txt(cells[5]) : "");
        const salaryText = txt(salaryEl) || (cells[6] ? txt(cells[6]) : "");
        const companySizeText = txt(companySizeEl) || (cells[7] ? txt(cells[7]) : "");
        const industryText = txt(industryEl) || (cells[8] ? txt(cells[8]) : "");
        const qualsText = txt(qualsEl) || (cells[9] ? txt(cells[9]) : "");
        const h1bText = txt(h1bEl) || (cells[10] ? txt(cells[10]) : "");
        const newGradText = txt(newGradEl) || (cells[11] ? txt(cells[11]) : "");

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

      // Try to extract current page number from pagination
      let currentPage = 1;
      const pageEl = document.querySelector(
        "[class*='pagination'] [class*='active'], [class*='pagination'] [aria-current='page']"
      );
      if (pageEl) {
        const num = parseInt(txt(pageEl), 10);
        if (!Number.isNaN(num)) currentPage = num;
      }

      return { rows: results, pageInfo: { currentPage, totalRows: results.length } };
    },
  });

  const extracted = results[0]?.result as
    | { rows: NewGradRow[]; pageInfo: { currentPage: number; totalRows: number } }
    | undefined;

  if (!extracted) {
    return {
      kind: "newgradExtractList",
      ok: false,
      error: { code: "INTERNAL", message: "content script returned no result" },
    };
  }

  return { kind: "newgradExtractList", ok: true, result: extracted };
}

async function handleNewGradScore(rows: NewGradRow[]): Promise<PopupResponse> {
  const state = await loadState();
  if (!state.bridgeToken) {
    return {
      kind: "newgradScore",
      ok: false,
      error: { code: "UNAUTHORIZED", message: "bridge token not configured" },
    };
  }
  const client = bridgeClientFromState(state);
  const res = await client.scoreNewGradRows(rows);
  if (res.ok) return { kind: "newgradScore", ok: true, result: res.result };
  return { kind: "newgradScore", ok: false, error: res.error };
}

async function handleNewGradEnrichDetails(
  promotedRows: ScoredRow[],
  config: { concurrent: number; delayMinMs: number; delayMaxMs: number }
): Promise<PopupResponse> {
  const enrichedRows: EnrichedRow[] = [];
  let failed = 0;
  const queue = [...promotedRows];

  while (queue.length > 0) {
    const batch = queue.splice(0, config.concurrent);
    const results = await Promise.all(batch.map(async (scored) => {
      try {
        // Open background tab
        const tab = await chrome.tabs.create({ url: scored.row.detailUrl, active: false });
        if (!tab.id) return null;

        // Wait for page load
        await new Promise<void>((resolve) => {
          const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
            if (tabId === tab.id && info.status === "complete") {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          // Timeout after 15s
          setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
        });

        // Inject detail extractor — FULLY self-contained inline function.
        const scriptResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
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
                  const next = el.nextElementSibling;
                  if (next) {
                    const val = txt(next);
                    if (val) return val;
                  }
                  const parentNext = el.parentElement?.nextElementSibling;
                  if (parentNext) {
                    const val = txt(parentNext);
                    if (val) return val;
                  }
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

            const matchScore = extractPercentage(
              /(\d+)\s*%\s*(?:GOOD\s+MATCH|GREAT\s+MATCH|MATCH)/i
            );
            const expLevelMatch = extractPercentage(
              /experience\s+level\s*(?:match)?\s*[:\s]*(\d+)\s*%/i
            );
            const skillMatch = extractPercentage(
              /skills?\s*(?:match)?\s*[:\s]*(\d+)\s*%/i
            );
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
          },
        });

        // Close tab
        await chrome.tabs.remove(tab.id);

        const detail = scriptResults[0]?.result as NewGradDetail | undefined;
        if (!detail) return null;

        return {
          row: scored,
          detail: { ...detail, position: scored.row.position },
        } as EnrichedRow;
      } catch {
        return null;
      }
    }));

    for (const r of results) {
      if (r) enrichedRows.push(r);
      else failed++;
    }

    // Random delay between batches
    if (queue.length > 0) {
      const delay = config.delayMinMs + Math.random() * (config.delayMaxMs - config.delayMinMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { kind: "newgradEnrichDetails", ok: true, result: { enrichedRows, failed } };
}

async function handleNewGradEnrich(rows: EnrichedRow[]): Promise<PopupResponse> {
  const state = await loadState();
  if (!state.bridgeToken) {
    return {
      kind: "newgradEnrich",
      ok: false,
      error: { code: "UNAUTHORIZED", message: "bridge token not configured" },
    };
  }
  const client = bridgeClientFromState(state);
  const res = await client.enrichNewGradRows(rows);
  if (res.ok) return { kind: "newgradEnrich", ok: true, result: res.result };
  return { kind: "newgradEnrich", ok: false, error: res.error };
}

/* -------------------------------------------------------------------------- */
/*  SSE streams and port fan-out                                              */
/* -------------------------------------------------------------------------- */

function openStream(jobId: JobId, state: ExtensionState): void {
  if (subscriptions.has(jobId)) return; // already streaming
  const controller = new AbortController();
  const sub: Subscription = { controller, ports: new Set() };
  subscriptions.set(jobId, sub);

  const client = bridgeClientFromState(state);
  void client
    .streamJob(
      jobId,
      (event) => {
        fanEvent(jobId, event);
        if (event.kind === "done" || event.kind === "failed") {
          closeStream(jobId, event.kind);
        }
      },
      controller.signal
    )
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      fanEvent(jobId, {
        kind: "failed",
        jobId,
        error: { code: "INTERNAL", message },
      });
      closeStream(jobId, "failed");
    });
}

function fanEvent(jobId: JobId, event: JobEvent): void {
  const sub = subscriptions.get(jobId);
  if (!sub) return;
  const message: JobPortMessage = { channel: "job", event };
  for (const port of sub.ports) {
    try {
      port.postMessage(message);
    } catch {
      // port disconnected; remove on next prune
    }
  }
}

function closeStream(jobId: JobId, reason: "done" | "failed"): void {
  const sub = subscriptions.get(jobId);
  if (!sub) return;
  const closedMsg: JobPortMessage = {
    channel: "job",
    event: { kind: "closed", jobId, reason },
  };
  for (const port of sub.ports) {
    try {
      port.postMessage(closedMsg);
    } catch {
      /* ignore */
    }
  }
  sub.controller.abort();
  subscriptions.delete(jobId);
}

/* -------------------------------------------------------------------------- */
/*  Long-lived ports for popup subscriptions                                  */
/* -------------------------------------------------------------------------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "career-ops.job") return;
  // The first message from the popup names the jobId.
  const onInit = (msg: unknown) => {
    if (
      typeof msg !== "object" ||
      msg === null ||
      (msg as { jobId?: unknown }).jobId === undefined
    ) {
      return;
    }
    const jobId = (msg as { jobId: string }).jobId as JobId;
    const sub = subscriptions.get(jobId);
    if (!sub) {
      port.postMessage({
        channel: "job",
        event: {
          kind: "failed",
          jobId,
          error: {
            code: "NOT_FOUND",
            message: "no active subscription for this jobId",
          },
        },
      } satisfies JobPortMessage);
      return;
    }
    sub.ports.add(port);
    port.onDisconnect.addListener(() => {
      sub.ports.delete(port);
    });
  };
  port.onMessage.addListener(onInit);
});
