/**
 * popup/index.ts — popup controller.
 *
 * State machine:
 *   idle      → on open, send captureActiveTab to background
 *   captured  → show URL + title + Evaluate CTA
 *   running   → phase list, driven by SSE events fanned via port
 *   done      → score + Open Report button
 *   error     → error code + Retry
 *
 * No framework, no innerHTML. All user-derived strings go through the
 * DOM as `textContent` so there is no XSS path — even if the bridge
 * returns hostile content scraped from a malicious job page.
 */

import type {
  BridgePreset,
  CapturedTab,
  ExtensionState,
  JobPortMessage,
  PopupRequest,
  PopupResponse,
} from "../contracts/messages.js";
import { STATE_STORAGE_KEY } from "../contracts/messages.js";
import type {
  EvaluationResult,
  HealthResult,
  JobPhase,
  JobEvent,
  JobId,
  JobSnapshot,
} from "../contracts/bridge-wire.js";

type UiState = "idle" | "setup" | "captured" | "notDetected" | "running" | "done" | "error";

const PHASE_ORDER: readonly JobPhase[] = [
  "queued",
  "extracting_jd",
  "evaluating",
  "writing_report",
  "generating_pdf",
  "writing_tracker",
  "completed",
];

const PHASE_LABEL: Record<JobPhase, string> = {
  queued: "Queued",
  extracting_jd: "Extracting job description",
  evaluating: "Evaluating (A–F blocks)",
  writing_report: "Writing report",
  generating_pdf: "PDF step",
  writing_tracker: "Writing tracker row",
  completed: "Completed",
  failed: "Failed",
};

/* -------------------------------------------------------------------------- */
/*  DOM handles                                                               */
/* -------------------------------------------------------------------------- */

const app = document.getElementById("app")!;
const healthEl = document.getElementById("health")!;
const setupEl = document.getElementById("setup")!;
const setupTokenInput = document.getElementById("setup-token") as HTMLInputElement;
const setupSaveBtn = document.getElementById("setup-save-btn") as HTMLButtonElement;
const modeSelect = document.getElementById("mode-select") as HTMLSelectElement;
const modeCurrentEl = document.getElementById("mode-current")!;
const modeMatchEl = document.getElementById("mode-match")!;
const modeHelpEl = document.getElementById("mode-help")!;
const modeCommandEl = document.getElementById("mode-command")!;
const modeCopyBtn = document.getElementById("mode-copy-btn") as HTMLButtonElement;
const captureEl = document.getElementById("capture")!;
const notDetectedEl = document.getElementById("not-detected")!;
const runningEl = document.getElementById("running")!;
const doneEl = document.getElementById("done")!;
const errorEl = document.getElementById("error")!;

const captureUrlEl = document.getElementById("capture-url")!;
const captureTitleEl = document.getElementById("capture-title")!;
const captureDetectionEl = document.getElementById("capture-detection")!;
const evaluateBtn = document.getElementById("evaluate-btn") as HTMLButtonElement;

const jobIdEl = document.getElementById("job-id")!;
const phaseListEl = document.getElementById("phase-list")!;

const resultHeaderEl = document.getElementById("result-header")!;
const resultTldrEl = document.getElementById("result-tldr")!;
const openReportBtn = document.getElementById("open-report-btn") as HTMLButtonElement;

const errorCodeEl = document.getElementById("error-code")!;
const errorMessageEl = document.getElementById("error-message")!;
const retryBtn = document.getElementById("retry-btn") as HTMLButtonElement;

const recentListEl = document.getElementById("recent-list")!;
const mergeTrackerBtn = document.getElementById("merge-tracker-btn") as HTMLButtonElement;
const offlineBannerEl = document.getElementById("offline-banner")!;

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

let captured: CapturedTab | null = null;
let currentJobId: JobId | null = null;
let currentResult: EvaluationResult | null = null;
let activePort: chrome.runtime.Port | null = null;
let preferredPreset: BridgePreset = "real-codex";
let currentBridgePreset: BridgePreset | null = null;

/* -------------------------------------------------------------------------- */
/*  UI switching                                                              */
/* -------------------------------------------------------------------------- */

function show(state: UiState): void {
  setupEl.classList.toggle("hidden", state !== "setup");
  captureEl.classList.toggle("hidden", state !== "captured");
  notDetectedEl.classList.toggle("hidden", state !== "notDetected");
  runningEl.classList.toggle("hidden", state !== "running");
  doneEl.classList.toggle("hidden", state !== "done");
  errorEl.classList.toggle("hidden", state !== "error");
  app.className = `state-${state}`;
}

function setHealth(state: "unknown" | "ok" | "bad" | "warn", label: string): void {
  healthEl.dataset.state = state;
  const labelEl = healthEl.querySelector(".label");
  if (labelEl) labelEl.textContent = label;
}

/* -------------------------------------------------------------------------- */
/*  Messaging helpers                                                         */
/* -------------------------------------------------------------------------- */

function sendRequest<K extends PopupRequest["kind"]>(
  req: Extract<PopupRequest, { kind: K }>
): Promise<Extract<PopupResponse, { kind: K }>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, (res: PopupResponse) => {
      resolve(res as Extract<PopupResponse, { kind: K }>);
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Flow                                                                      */
/* -------------------------------------------------------------------------- */

async function init(): Promise<void> {
  // Cached health — make the popup feel instant.
  const stored = await chrome.storage.local.get(STATE_STORAGE_KEY);
  const state = stored[STATE_STORAGE_KEY] as ExtensionState | undefined;
  preferredPreset = state?.preferredBridgePreset ?? preferredPreset;
  modeSelect.value = preferredPreset;
  renderModePanel();
  if (state?.lastHealthAt != null && state.lastHealthOk != null) {
    const age = Date.now() - new Date(state.lastHealthAt).getTime();
    if (age < 30_000) {
      if (state.lastHealthOk) {
        setHealth("ok", "bridge");
        offlineBannerEl.classList.add("hidden");
      } else {
        setHealth("bad", "offline");
        offlineBannerEl.classList.remove("hidden");
      }
    }
  }

  const preferenceRes = await sendRequest({ kind: "getModePreference" });
  if (preferenceRes.ok) {
    preferredPreset = preferenceRes.result.preset;
    modeSelect.value = preferredPreset;
    renderModePanel();
  }

  const tokenRes = await sendRequest({ kind: "hasToken" });
  if (!tokenRes.ok || !tokenRes.result.present) {
    show("setup");
    setupTokenInput.focus();
    return;
  }
  void refreshHealth();

  // Reopen recovery — show cached result if available.
  if (state?.lastResult) {
    currentJobId = state.lastResult.jobId;
    currentResult = state.lastResult.result;
    renderDone(state.lastResult.result);
  }

  // Run capture in parallel (user may want to evaluate a new job).
  await runCapture();

  void loadRecentJobs();
}

async function onSetupSaveClick(): Promise<void> {
  const token = setupTokenInput.value.trim();
  setupSaveBtn.disabled = true;
  const res = await sendRequest({ kind: "setToken", token });
  setupSaveBtn.disabled = false;
  if (!res.ok) {
    renderError(res.error.code, res.error.message);
    return;
  }
  // Token saved — move into the normal flow.
  setupTokenInput.value = "";
  void refreshHealth();
  await runCapture();
}

async function refreshHealth(): Promise<void> {
  setHealth("unknown", "checking…");
  const res = await sendRequest({ kind: "getHealth" });
  if (res.ok) {
    setHealth("ok", `bridge ${res.result.bridgeVersion}`);
    offlineBannerEl.classList.add("hidden");
    currentBridgePreset = presetFromHealth(res.result);
    renderModePanel(res.result);
  } else {
    setHealth("bad", res.error.code);
    offlineBannerEl.classList.remove("hidden");
    currentBridgePreset = null;
    renderModePanel();
  }
}

async function runCapture(): Promise<void> {
  const res = await sendRequest({ kind: "captureActiveTab" });
  if (!res.ok) {
    renderError(res.error.code, res.error.message);
    return;
  }
  captured = res.result;
  renderCaptured(captured);
}

function renderCaptured(cap: CapturedTab): void {
  captureUrlEl.textContent = cap.url;
  captureTitleEl.textContent = cap.title || "(no title)";
  const label =
    cap.detection.label === "job_posting"
      ? `detected job posting (${pct(cap.detection.confidence)})`
      : cap.detection.label === "likely_job_posting"
        ? `likely job posting (${pct(cap.detection.confidence)})`
        : "not a job posting (heuristic)";
  captureDetectionEl.textContent = label;

  if (cap.detection.label === "not_job_posting") {
    show("notDetected");
    return;
  }
  show("captured");
}

async function onEvaluateClick(): Promise<void> {
  if (!captured) return;
  evaluateBtn.disabled = true;
  const res = await sendRequest({
    kind: "startEvaluation",
    input: {
      url: captured.url,
      title: captured.title,
      pageText: captured.pageText,
      detection: captured.detection,
    },
  });
  evaluateBtn.disabled = false;
  if (!res.ok) {
    renderError(res.error.code, res.error.message);
    return;
  }
  currentJobId = res.result.jobId;
  jobIdEl.textContent = `job ${currentJobId}`;
  renderPhases(res.result.initialSnapshot);
  show("running");
  subscribeToJob(currentJobId);
}

function subscribeToJob(jobId: JobId): void {
  activePort?.disconnect();
  const port = chrome.runtime.connect({ name: "career-ops.job" });
  activePort = port;
  port.postMessage({ jobId });
  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as JobPortMessage;
    if (msg.channel !== "job") return;
    handleJobEvent(msg.event);
  });
}

function handleJobEvent(
  event: JobEvent | { kind: "closed"; jobId: JobId; reason: "done" | "failed" | "client" }
): void {
  if (event.kind === "snapshot") {
    renderPhases(event.snapshot);
    return;
  }
  if (event.kind === "phase") {
    appendPhase(event.phase);
    return;
  }
  if (event.kind === "done") {
    currentResult = event.result;
    renderDone(event.result);
    return;
  }
  if (event.kind === "failed") {
    renderError(event.error.code, event.error.message);
    return;
  }
  // closed — ignore; terminal event already handled.
}

function renderPhases(snap: JobSnapshot): void {
  // Rebuild the list from scratch; cheap and correct.
  while (phaseListEl.firstChild) phaseListEl.removeChild(phaseListEl.firstChild);
  const done = new Set(snap.progress?.phases.map((p) => p.phase) ?? []);
  for (const phase of PHASE_ORDER) {
    const li = document.createElement("li");
    li.textContent = PHASE_LABEL[phase];
    if (snap.phase === "failed") {
      li.className = done.has(phase) ? "completed" : "";
      if (phase === snap.phase) li.className = "failed";
    } else if (phase === snap.phase) {
      li.className = "active";
    } else if (done.has(phase)) {
      li.className = "completed";
    }
    phaseListEl.appendChild(li);
  }
}

function appendPhase(phase: JobPhase): void {
  const items = Array.from(phaseListEl.children) as HTMLLIElement[];
  const reachedIdx = PHASE_ORDER.indexOf(phase);
  if (reachedIdx < 0) return;
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const li = items[i];
    if (!li) continue;
    if (i === reachedIdx) {
      li.className = "active";
    } else if (i < reachedIdx) {
      li.className = "completed";
    }
  }
}

function renderDone(result: EvaluationResult): void {
  // Build DOM nodes explicitly. Every user-derived string goes in via
  // textContent — no innerHTML anywhere in this function.
  while (resultHeaderEl.firstChild)
    resultHeaderEl.removeChild(resultHeaderEl.firstChild);

  const companyBold = document.createElement("strong");
  companyBold.textContent = result.company;

  const dashRoleText = document.createTextNode(` — ${result.role}`);
  const br = document.createElement("br");

  const scoreSpan = document.createElement("span");
  scoreSpan.className = "score";
  scoreSpan.textContent = `${result.score.toFixed(1)}/5`;

  const dotArchetypeText = document.createTextNode(` · ${result.archetype}`);

  resultHeaderEl.appendChild(companyBold);
  resultHeaderEl.appendChild(dashRoleText);
  resultHeaderEl.appendChild(br);
  resultHeaderEl.appendChild(scoreSpan);
  resultHeaderEl.appendChild(dotArchetypeText);

  resultTldrEl.textContent = result.tldr;
  show("done");
}

async function onOpenReportClick(): Promise<void> {
  if (!currentResult) return;
  await sendRequest({
    kind: "openPath",
    absolutePath: currentResult.reportPath,
  });
}

function renderError(code: string, message: string): void {
  errorCodeEl.textContent = code;
  errorMessageEl.textContent = message;
  show("error");
}

function renderModePanel(health?: HealthResult): void {
  modeSelect.value = preferredPreset;
  modeHelpEl.textContent = presetDescription(preferredPreset);
  modeCommandEl.textContent = presetCommand(preferredPreset);

  const currentText = currentBridgePreset
    ? `Current bridge: ${presetDisplayName(currentBridgePreset)}`
    : health
      ? `Current bridge: ${health.execution.mode}`
      : "Current bridge: unknown";
  modeCurrentEl.textContent = currentText;

  if (!currentBridgePreset) {
    modeMatchEl.dataset.match = "no";
    modeMatchEl.textContent =
      "Restart the local bridge with the command below if you want this preset.";
    return;
  }

  const matches = currentBridgePreset === preferredPreset;
  modeMatchEl.dataset.match = matches ? "yes" : "no";
  modeMatchEl.textContent = matches
    ? "Bridge already matches your preferred preset."
    : "Bridge is running a different preset. Restart it with the command below to switch.";
}

async function onModeChange(): Promise<void> {
  preferredPreset = modeSelect.value as BridgePreset;
  renderModePanel();
  const res = await sendRequest({
    kind: "setModePreference",
    preset: preferredPreset,
  });
  if (!res.ok) {
    renderError(res.error.code, res.error.message);
    return;
  }
  preferredPreset = res.result.preset;
  renderModePanel();
}

async function onCopyModeCommand(): Promise<void> {
  const text = presetCommand(preferredPreset);
  try {
    await navigator.clipboard.writeText(text);
    modeCopyBtn.textContent = "Copied";
    setTimeout(() => {
      modeCopyBtn.textContent = "Copy start command";
    }, 1500);
  } catch {
    modeCopyBtn.textContent = "Copy failed";
    setTimeout(() => {
      modeCopyBtn.textContent = "Copy start command";
    }, 1500);
  }
}

async function onRetryClick(): Promise<void> {
  if (currentJobId) {
    currentJobId = null;
    currentResult = null;
  }
  await runCapture();
}

/* -------------------------------------------------------------------------- */
/*  Recent evaluations                                                        */
/* -------------------------------------------------------------------------- */

async function loadRecentJobs(): Promise<void> {
  try {
    const res = await sendRequest({ kind: "getRecentJobs", limit: 8 });
    if (!res.ok) return; // silently fail — recent is informational
    const { rows } = res.result;
    if (rows.length === 0) return; // leave the "No evaluations yet" placeholder

    while (recentListEl.firstChild) recentListEl.removeChild(recentListEl.firstChild);

    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "recent-item";

      const left = document.createElement("span");
      const companySpan = document.createElement("span");
      companySpan.className = "company";
      companySpan.textContent = row.company;
      const roleSpan = document.createElement("span");
      roleSpan.className = "role";
      roleSpan.textContent = row.role;
      left.appendChild(companySpan);
      left.appendChild(roleSpan);

      const scoreSpan = document.createElement("span");
      scoreSpan.className = "score";
      scoreSpan.textContent = row.score;

      item.appendChild(left);
      item.appendChild(scoreSpan);

      const reportNum = row.num;
      item.addEventListener("click", () => {
        void (async () => {
          const reportRes = await sendRequest({ kind: "readReport", reportNum });
          if (reportRes.ok) {
            void sendRequest({ kind: "openPath", absolutePath: reportRes.result.path });
          }
        })();
      });

      recentListEl.appendChild(item);
    }
  } catch {
    // silently fail — recent is informational, not critical
  }
}

async function onMergeTrackerClick(): Promise<void> {
  mergeTrackerBtn.disabled = true;
  mergeTrackerBtn.textContent = "Merging\u2026";
  const res = await sendRequest({ kind: "mergeTracker", dryRun: false });
  mergeTrackerBtn.disabled = false;
  if (res.ok) {
    mergeTrackerBtn.textContent = `\u2713 Merged (${res.result.added} added)`;
    void loadRecentJobs();
  } else {
    mergeTrackerBtn.textContent = "Merge failed";
  }
}

/* -------------------------------------------------------------------------- */
/*  Utilities                                                                 */
/* -------------------------------------------------------------------------- */

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function presetFromHealth(health: HealthResult): BridgePreset | null {
  if (health.execution.mode === "fake") return "fake";
  if (health.execution.mode === "sdk") return "sdk";
  if (health.execution.mode === "real") {
    return health.execution.realExecutor === "codex"
      ? "real-codex"
      : "real-claude";
  }
  return null;
}

function presetDisplayName(preset: BridgePreset): string {
  switch (preset) {
    case "fake":
      return "fake";
    case "real-claude":
      return "real / claude";
    case "real-codex":
      return "real / codex";
    case "sdk":
      return "sdk";
  }
}

function presetDescription(preset: BridgePreset): string {
  switch (preset) {
    case "fake":
      return "Fast UI smoke mode. No real report or PDF files are written.";
    case "real-claude":
      return "Full checked-in career-ops flow using claude -p as the executor.";
    case "real-codex":
      return "Full checked-in career-ops flow using codex exec as the executor.";
    case "sdk":
      return "Direct Anthropic SDK mode. Report and tracker write, but PDF is currently skipped.";
  }
}

function presetCommand(preset: BridgePreset): string {
  switch (preset) {
    case "fake":
      return "npm --prefix bridge run start";
    case "real-claude":
      return "CAREER_OPS_BRIDGE_MODE=real npm --prefix bridge run start";
    case "real-codex":
      return "CAREER_OPS_BRIDGE_MODE=real CAREER_OPS_REAL_EXECUTOR=codex npm --prefix bridge run start";
    case "sdk":
      return "CAREER_OPS_BRIDGE_MODE=sdk ANTHROPIC_API_KEY=... npm --prefix bridge run start";
  }
}

/* -------------------------------------------------------------------------- */
/*  Wire events                                                               */
/* -------------------------------------------------------------------------- */

evaluateBtn.addEventListener("click", () => void onEvaluateClick());
openReportBtn.addEventListener("click", () => void onOpenReportClick());
retryBtn.addEventListener("click", () => void onRetryClick());
setupSaveBtn.addEventListener("click", () => void onSetupSaveClick());
mergeTrackerBtn.addEventListener("click", () => void onMergeTrackerClick());
modeSelect.addEventListener("change", () => void onModeChange());
modeCopyBtn.addEventListener("click", () => void onCopyModeCommand());

void init();
