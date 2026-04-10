/**
 * messages.ts — in-extension message contracts.
 *
 * Three message channels exist inside a Manifest V3 extension:
 *   1. popup ↔ background service worker  (chrome.runtime.sendMessage)
 *   2. background ↔ content script          (chrome.tabs.sendMessage)
 *   3. popup ↔ bridge (HTTP, not messages — see bridge-wire.ts)
 *
 * This file defines (1) and (2). HTTP traffic is modeled in bridge-wire.ts.
 *
 * Design rules:
 *   • Every message is a discriminated union by `kind`.
 *   • Every request has a matching response type.
 *   • No implicit fields. No `any`.
 *   • popup NEVER talks to content scripts directly — always via
 *     background. This keeps the content-script permission surface
 *     narrow and auditable.
 *
 * CONTRACTS ONLY. No runtime.
 */

import type {
  EvaluationInput,
  EvaluationResult,
  JobEvent,
  JobId,
  JobSnapshot,
  PageDetection,
  ReportReadResult,
  TrackerRow,
} from "./bridge-wire.js";
import type {
  HealthResult,
  LivenessResult,
} from "./bridge-wire.js";
import type { BridgeError } from "./bridge-wire.js";

export interface MergeReport {
  added: number;
  updated: number;
  skipped: number;
  dryRun: boolean;
}

/* -------------------------------------------------------------------------- */
/*  popup -> background                                                       */
/* -------------------------------------------------------------------------- */

export type PopupRequest =
  /** Ask background whether a bridge token has been stored. */
  | { kind: "hasToken" }
  /** Store the bridge token (first-time setup). */
  | { kind: "setToken"; token: string }
  /** Ask background to return the current health snapshot (cached 5s). */
  | { kind: "getHealth" }
  /** Ask background to capture the active tab's job-page context. */
  | { kind: "captureActiveTab" }
  /** Ask background to run URL liveness via the bridge. */
  | { kind: "checkLiveness"; url: string }
  /**
   * Ask background to kick off an evaluation. Background generates a
   * requestId, calls the bridge, and returns the jobId. The popup then
   * calls `subscribeJob` to receive live updates.
   */
  | { kind: "startEvaluation"; input: EvaluationInput }
  /**
   * Subscribe to a running job. Background maintains the SSE connection
   * and re-fans the events to the popup via chrome.runtime long-lived
   * ports. The popup never opens HTTP connections directly.
   */
  | { kind: "subscribeJob"; jobId: JobId }
  /** Cancel a subscription. Does NOT cancel the underlying job. */
  | { kind: "unsubscribeJob"; jobId: JobId }
  /** Ask background to open a file:// URL in a new tab. */
  | { kind: "openPath"; absolutePath: string }
  /** Ask background to fetch recent tracker rows from the bridge. */
  | { kind: "getRecentJobs"; limit?: number }
  /** Ask background to read a single evaluation report by number. */
  | { kind: "readReport"; reportNum: number }
  /** Ask background to merge tracker additions via the bridge. */
  | { kind: "mergeTracker"; dryRun?: boolean };

/**
 * popup <- background responses. Each one corresponds by `kind` to a
 * PopupRequest of the same name. The popup always sees either an `ok`
 * case or an `error` case carrying a BridgeError.
 */
export type PopupResponse =
  | { kind: "hasToken"; ok: true; result: { present: boolean } }
  | { kind: "hasToken"; ok: false; error: BridgeError }
  | { kind: "setToken"; ok: true; result: { saved: true } }
  | { kind: "setToken"; ok: false; error: BridgeError }
  | { kind: "getHealth"; ok: true; result: HealthResult }
  | { kind: "getHealth"; ok: false; error: BridgeError }
  | { kind: "captureActiveTab"; ok: true; result: CapturedTab }
  | { kind: "captureActiveTab"; ok: false; error: BridgeError }
  | { kind: "checkLiveness"; ok: true; result: LivenessResult }
  | { kind: "checkLiveness"; ok: false; error: BridgeError }
  | {
      kind: "startEvaluation";
      ok: true;
      result: { jobId: JobId; initialSnapshot: JobSnapshot };
    }
  | { kind: "startEvaluation"; ok: false; error: BridgeError }
  | { kind: "subscribeJob"; ok: true; result: { subscribed: true } }
  | { kind: "subscribeJob"; ok: false; error: BridgeError }
  | { kind: "unsubscribeJob"; ok: true; result: { unsubscribed: true } }
  | { kind: "unsubscribeJob"; ok: false; error: BridgeError }
  | { kind: "openPath"; ok: true; result: { opened: true } }
  | { kind: "openPath"; ok: false; error: BridgeError }
  | { kind: "getRecentJobs"; ok: true; result: { rows: readonly TrackerRow[]; totalRows: number } }
  | { kind: "getRecentJobs"; ok: false; error: BridgeError }
  | { kind: "readReport"; ok: true; result: ReportReadResult }
  | { kind: "readReport"; ok: false; error: BridgeError }
  | { kind: "mergeTracker"; ok: true; result: MergeReport }
  | { kind: "mergeTracker"; ok: false; error: BridgeError };

/**
 * Long-lived port messages pushed from background to popup for an
 * active job subscription. The popup renders these directly.
 *
 * This is a thin pass-through of the bridge's JobEvent, wrapped with
 * a `channel: "job"` discriminator so the popup can multiplex multiple
 * subscriptions over one port if needed.
 */
export type JobPortMessage =
  | { channel: "job"; event: JobEvent }
  | {
      channel: "job";
      event: { kind: "closed"; jobId: JobId; reason: "done" | "failed" | "client" };
    };

/* -------------------------------------------------------------------------- */
/*  background -> content script                                              */
/* -------------------------------------------------------------------------- */

/**
 * The content script is stateless and only responds to capture requests.
 * It never talks to the bridge and never reads chrome.storage.
 */
export type ContentRequest = { kind: "capturePage" };

export type ContentResponse =
  | { kind: "capturePage"; ok: true; result: CapturedTab }
  | { kind: "capturePage"; ok: false; error: { message: string } };

/* -------------------------------------------------------------------------- */
/*  Shared capture payload                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything the content script extracts from a page in one go.
 *
 * `pageText` is the heuristic JD body — we do not ship the full DOM.
 * The bridge will re-extract using Playwright if `pageText` is short
 * or empty.
 *
 * The content script does NOT classify the page as a job posting by
 * itself; it records heuristic signals in `detection` and lets the
 * popup decide whether to show the Evaluate CTA.
 */
export interface CapturedTab {
  tabId: number;
  url: string;
  title: string;
  /** Best-effort body extract, bounded by EXTRACT_MAX_CHARS. */
  pageText: string;
  /** Best-effort heuristic detection from the content script. */
  detection: PageDetection;
  capturedAt: string; // ISO-8601 UTC
}

export const EXTRACT_MAX_CHARS = 20_000;

/* -------------------------------------------------------------------------- */
/*  Persistent extension state                                                */
/* -------------------------------------------------------------------------- */

/**
 * The only values the extension persists locally. PII never goes here.
 * Stored in chrome.storage.local under the key "careerOps.state.v1".
 */
export interface ExtensionState {
  /** Bridge host override (defaults handled by background). */
  bridgeHost: string;
  bridgePort: number;
  /** Shared secret, copied from bridge/.bridge-token on setup. */
  bridgeToken: string;
  /** Last health snapshot, for fast popup render. */
  lastHealthAt?: string;
  lastHealthOk?: boolean;
  /** Most recent jobId the popup watched. Not a history log. */
  lastJobId?: JobId;
  /** Cached copy of the last completed evaluation for the popup
   *  "what just happened" view. */
  lastResult?: {
    jobId: JobId;
    at: string;
    result: EvaluationResult;
  };
}

export const STATE_STORAGE_KEY = "careerOps.state.v1" as const;
