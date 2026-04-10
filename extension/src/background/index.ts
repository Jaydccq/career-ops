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
  JobEvent,
  JobId,
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
