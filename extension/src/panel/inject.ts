/**
 * inject.ts — floating panel injected into the page via content script.
 *
 * Creates a shadow-DOM container with the career-ops panel UI.
 * Features:
 *   • Draggable by the header bar
 *   • Persists across focus changes (it's part of the page DOM)
 *   • Toggled by toolbar icon click (message from background)
 *   • Remembers position via chrome.storage.local
 *   • Shadow DOM isolates styles from the host page
 *
 * All communication with the bridge goes through chrome.runtime messages
 * to the background service worker, same as the old popup.
 */

const PANEL_ID = "career-ops-panel-root";
const STORAGE_POS_KEY = "careerOps.panelPos";

function getOrCreatePanel(): { root: HTMLElement; shadow: ShadowRoot; existed: boolean } {
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    return { root: existing, shadow: existing.shadowRoot!, existed: true };
  }

  const root = document.createElement("div");
  root.id = PANEL_ID;
  root.style.cssText = "all:initial; position:fixed; z-index:2147483647; top:80px; right:20px;";
  const shadow = root.attachShadow({ mode: "open" });
  document.body.appendChild(root);
  return { root, shadow, existed: false };
}

function buildStyles(): string {
  return `
:host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
* { box-sizing: border-box; }

.panel-container {
  width: 380px;
  background: #0f0f10;
  color: #e8e8ea;
  border: 1px solid #26262a;
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  font-size: 13px;
  line-height: 1.45;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 80vh;
}

.drag-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #181819;
  cursor: grab;
  user-select: none;
  border-bottom: 1px solid #26262a;
}
.drag-bar:active { cursor: grabbing; }
.drag-bar h1 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: #e8e8ea; }

.health { display: flex; align-items: center; gap: 5px; font-size: 10px; color: #8f8f94; }
.health .dot { width: 7px; height: 7px; border-radius: 50%; background: #8f8f94; }
.health[data-state="ok"] .dot { background: #4ecb71; }
.health[data-state="bad"] .dot { background: #ef5f5f; }

.close-btn {
  background: none; border: none; color: #8f8f94; font-size: 16px;
  cursor: pointer; padding: 0 4px; line-height: 1;
}
.close-btn:hover { color: #e8e8ea; }

.panel-body {
  padding: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section {
  background: #181819;
  border: 1px solid #26262a;
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-title {
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: #8f8f94;
}

.hidden { display: none !important; }

.capture-url { font-size: 11px; color: #8f8f94; word-break: break-all; }
.capture-title { font-size: 13px; font-weight: 500; }
.capture-detection { font-size: 11px; color: #8f8f94; }

.cta {
  appearance: none; background: transparent; color: #e8e8ea;
  border: 1px solid #26262a; border-radius: 4px; padding: 7px 10px;
  font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
}
.cta:hover { background: #202024; }
.cta.primary { background: #7aa7ff; color: #000; border-color: #7aa7ff; }
.cta.primary:hover { background: #5c8eff; border-color: #5c8eff; }
.cta:disabled { opacity: 0.5; cursor: default; }

.job-id { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8f8f94; }
.phase-list { margin: 0; padding: 0 0 0 16px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.phase-list li { color: #8f8f94; }
.phase-list li.active { color: #e8e8ea; font-weight: 500; }
.phase-list li.completed { color: #4ecb71; }
.phase-list li.failed { color: #ef5f5f; }

.result { font-size: 13px; font-weight: 500; }
.result .score { color: #7aa7ff; font-weight: 600; }
.result-tldr { font-size: 11px; color: #8f8f94; line-height: 1.5; }
.result-actions { display: flex; gap: 6px; flex-wrap: wrap; }

.error-code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #ef5f5f; }
.error-message { font-size: 12px; }

.offline-banner {
  background: #2a1a1a; border: 1px solid #ef5f5f; border-radius: 4px;
  padding: 6px 10px; font-size: 11px; color: #ef5f5f;
}
.offline-banner code { color: #e8e8ea; }

.setup-hint { margin: 0; font-size: 11px; color: #8f8f94; line-height: 1.5; }
.setup-cmd { font-family: ui-monospace, Menlo, monospace; background: #000; padding: 2px 6px; border-radius: 3px; color: #7aa7ff; }
.setup-input {
  appearance: none; background: #000; color: #e8e8ea;
  border: 1px solid #26262a; border-radius: 4px; padding: 7px 10px;
  font-family: ui-monospace, Menlo, monospace; font-size: 11px; outline: none; width: 100%;
}
.setup-input:focus { border-color: #7aa7ff; }

.recent-list { display: flex; flex-direction: column; gap: 3px; }
.recent-empty { font-size: 11px; color: #8f8f94; }
.recent-item {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 11px; padding: 3px 0; border-bottom: 1px solid #26262a; cursor: pointer;
}
.recent-item:last-child { border-bottom: none; }
.recent-item:hover .company { color: #7aa7ff; }
.recent-item .company { font-weight: 500; color: #e8e8ea; }
.recent-item .role { color: #8f8f94; margin-left: 4px; }
.recent-item .score { color: #7aa7ff; font-weight: 600; white-space: nowrap; }

.footer { text-align: center; font-size: 10px; color: #8f8f94; padding: 4px 0; }
`;
}

function buildHTML(): string {
  return `
<div class="panel-container">
  <div class="drag-bar" id="drag-bar">
    <h1>career-ops</h1>
    <div class="health" id="health" data-state="unknown">
      <span class="dot"></span>
      <span class="label">checking…</span>
    </div>
    <button class="close-btn" id="close-btn" title="Close">&times;</button>
  </div>
  <div class="panel-body">
    <div id="offline-banner" class="offline-banner hidden">
      Bridge not reachable. Run: <code>cd bridge && npm run start</code>
    </div>
    <div id="setup" class="section hidden">
      <div class="section-title">First-time setup</div>
      <p class="setup-hint">Paste your bridge token:<br/><code class="setup-cmd">cat &lt;repo&gt;/bridge/.bridge-token</code></p>
      <input type="password" id="setup-token" class="setup-input" placeholder="paste token…" />
      <button class="cta primary" id="setup-save-btn">Save token</button>
    </div>
    <div id="capture" class="section hidden">
      <div class="section-title">Detected page</div>
      <div class="capture-url" id="capture-url"></div>
      <div class="capture-title" id="capture-title"></div>
      <div class="capture-detection" id="capture-detection"></div>
      <button class="cta primary" id="evaluate-btn">Evaluate this job</button>
    </div>
    <div id="not-detected" class="section hidden">
      <div class="section-title">No job posting detected</div>
      <p style="margin:0;font-size:12px;color:#8f8f94;">Open a job posting page and click the extension again.</p>
    </div>
    <div id="running" class="section hidden">
      <div class="section-title">Running evaluation</div>
      <div class="job-id" id="job-id"></div>
      <ol class="phase-list" id="phase-list"></ol>
    </div>
    <div id="done" class="section hidden">
      <div class="section-title">Evaluation complete</div>
      <div class="result" id="result-header"></div>
      <div class="result-tldr" id="result-tldr"></div>
      <div class="result-actions">
        <button class="cta" id="open-report-btn">Open report</button>
        <button class="cta" id="merge-tracker-btn">Save to tracker</button>
      </div>
    </div>
    <div id="error" class="section hidden">
      <div class="section-title">Error</div>
      <div class="error-code" id="error-code"></div>
      <div class="error-message" id="error-message"></div>
      <button class="cta" id="retry-btn">Try again</button>
    </div>
    <div id="recent" class="section">
      <div class="section-title">Recent evaluations</div>
      <div class="recent-list" id="recent-list">
        <div class="recent-empty">No evaluations yet</div>
      </div>
    </div>
    <div class="footer">v0.1.0 · local bridge</div>
  </div>
</div>`;
}

/* -------------------------------------------------------------------------- */
/*  Panel controller (mirrors popup/index.ts logic)                            */
/* -------------------------------------------------------------------------- */

function initPanel(shadow: ShadowRoot, root: HTMLElement): void {
  const $ = (id: string) => shadow.getElementById(id)!;

  const dragBar = $("drag-bar");
  const closeBtn = $("close-btn");
  const healthEl = $("health");
  const offlineBanner = $("offline-banner");
  const setupEl = $("setup");
  const setupTokenInput = $("setup-token") as HTMLInputElement;
  const setupSaveBtn = $("setup-save-btn") as HTMLButtonElement;
  const captureEl = $("capture");
  const notDetectedEl = $("not-detected");
  const runningEl = $("running");
  const doneEl = $("done");
  const errorEl = $("error");
  const captureUrlEl = $("capture-url");
  const captureTitleEl = $("capture-title");
  const captureDetectionEl = $("capture-detection");
  const evaluateBtn = $("evaluate-btn") as HTMLButtonElement;
  const jobIdEl = $("job-id");
  const phaseListEl = $("phase-list");
  const resultHeaderEl = $("result-header");
  const resultTldrEl = $("result-tldr");
  const openReportBtn = $("open-report-btn") as HTMLButtonElement;
  const mergeTrackerBtn = $("merge-tracker-btn") as HTMLButtonElement;
  const errorCodeEl = $("error-code");
  const errorMessageEl = $("error-message");
  const retryBtn = $("retry-btn") as HTMLButtonElement;
  const recentListEl = $("recent-list");

  // --- Drag logic ---
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  dragBar.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    isDragging = true;
    dragOffsetX = me.clientX - root.offsetLeft;
    dragOffsetY = me.clientY - root.offsetTop;
    me.preventDefault();
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isDragging) return;
    const x = Math.max(0, Math.min(e.clientX - dragOffsetX, window.innerWidth - 100));
    const y = Math.max(0, Math.min(e.clientY - dragOffsetY, window.innerHeight - 100));
    root.style.left = x + "px";
    root.style.top = y + "px";
    root.style.right = "auto";
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    chrome.storage.local.set({
      [STORAGE_POS_KEY]: { left: root.style.left, top: root.style.top },
    });
  });

  // Restore saved position
  chrome.storage.local.get(STORAGE_POS_KEY, (data) => {
    const pos = data[STORAGE_POS_KEY];
    if (pos?.left && pos?.top) {
      root.style.left = pos.left;
      root.style.top = pos.top;
      root.style.right = "auto";
    }
  });

  // --- Close ---
  closeBtn.addEventListener("click", () => {
    root.style.display = "none";
  });

  // --- State machine ---
  type UiState = "idle" | "setup" | "captured" | "notDetected" | "running" | "done" | "error";
  let capturedData: { url: string; title: string; pageText: string; detection: any } | null = null;
  let currentJobId: string | null = null;
  let currentResult: any = null;
  let activePort: chrome.runtime.Port | null = null;

  const PHASE_ORDER = [
    "queued", "extracting_jd", "evaluating", "writing_report",
    "generating_pdf", "writing_tracker", "completed",
  ];
  const PHASE_LABEL: Record<string, string> = {
    queued: "Queued", extracting_jd: "Extracting job description",
    evaluating: "Evaluating (A–F blocks)", writing_report: "Writing report",
    generating_pdf: "Generating PDF", writing_tracker: "Writing tracker row",
    completed: "Completed", failed: "Failed",
  };

  function show(state: UiState): void {
    setupEl.classList.toggle("hidden", state !== "setup");
    captureEl.classList.toggle("hidden", state !== "captured");
    notDetectedEl.classList.toggle("hidden", state !== "notDetected");
    runningEl.classList.toggle("hidden", state !== "running");
    doneEl.classList.toggle("hidden", state !== "done");
    errorEl.classList.toggle("hidden", state !== "error");
  }

  function setHealth(state: string, label: string): void {
    healthEl.dataset.state = state;
    const labelEl = healthEl.querySelector(".label");
    if (labelEl) labelEl.textContent = label;
  }

  function sendMsg(msg: any): Promise<any> {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  function pct(n: number): string { return Math.round(n * 100) + "%"; }

  async function refreshHealth(): Promise<void> {
    setHealth("unknown", "checking…");
    const res = await sendMsg({ kind: "getHealth" });
    if (res?.ok) {
      setHealth("ok", "bridge " + (res.result?.bridgeVersion ?? ""));
      offlineBanner.classList.add("hidden");
    } else {
      setHealth("bad", res?.error?.code ?? "offline");
      offlineBanner.classList.remove("hidden");
    }
  }

  async function runCapture(): Promise<void> {
    const res = await sendMsg({ kind: "captureActiveTab" });
    if (!res?.ok) {
      renderError(res?.error?.code ?? "INTERNAL", res?.error?.message ?? "capture failed");
      return;
    }
    capturedData = res.result;
    renderCaptured(res.result);
  }

  function renderCaptured(cap: any): void {
    captureUrlEl.textContent = cap.url;
    captureTitleEl.textContent = cap.title || "(no title)";
    const label = cap.detection?.label === "job_posting"
      ? "detected job posting (" + pct(cap.detection.confidence) + ")"
      : cap.detection?.label === "likely_job_posting"
        ? "likely job posting (" + pct(cap.detection.confidence) + ")"
        : "not a job posting (heuristic)";
    captureDetectionEl.textContent = label;
    if (cap.detection?.label === "not_job_posting") { show("notDetected"); return; }
    show("captured");
  }

  async function onEvaluateClick(): Promise<void> {
    if (!capturedData) return;
    evaluateBtn.disabled = true;
    const res = await sendMsg({
      kind: "startEvaluation",
      input: {
        url: capturedData.url,
        title: capturedData.title,
        pageText: capturedData.pageText,
        detection: capturedData.detection,
      },
    });
    evaluateBtn.disabled = false;
    if (!res?.ok) { renderError(res?.error?.code ?? "INTERNAL", res?.error?.message ?? "failed"); return; }
    currentJobId = res.result.jobId;
    jobIdEl.textContent = "job " + currentJobId;
    renderPhases(res.result.initialSnapshot);
    show("running");
    subscribeToJob(currentJobId!);
  }

  function subscribeToJob(jobId: string): void {
    activePort?.disconnect();
    const port = chrome.runtime.connect({ name: "career-ops.job" });
    activePort = port;
    port.postMessage({ jobId });
    port.onMessage.addListener((raw: any) => {
      if (raw?.channel !== "job") return;
      handleJobEvent(raw.event);
    });
  }

  function handleJobEvent(event: any): void {
    if (event.kind === "snapshot") { renderPhases(event.snapshot); return; }
    if (event.kind === "phase") { appendPhase(event.phase); return; }
    if (event.kind === "done") { currentResult = event.result; renderDone(event.result); return; }
    if (event.kind === "failed") { renderError(event.error.code, event.error.message); return; }
  }

  function renderPhases(snap: any): void {
    while (phaseListEl.firstChild) phaseListEl.removeChild(phaseListEl.firstChild);
    const done = new Set((snap.progress?.phases ?? []).map((p: any) => p.phase));
    for (const phase of PHASE_ORDER) {
      const li = document.createElement("li");
      li.textContent = PHASE_LABEL[phase] ?? phase;
      if (phase === snap.phase) li.className = "active";
      else if (done.has(phase)) li.className = "completed";
      phaseListEl.appendChild(li);
    }
  }

  function appendPhase(phase: string): void {
    const items = Array.from(phaseListEl.children) as HTMLLIElement[];
    const idx = PHASE_ORDER.indexOf(phase);
    if (idx < 0) return;
    for (let i = 0; i < PHASE_ORDER.length; i++) {
      const li = items[i];
      if (!li) continue;
      if (i === idx) li.className = "active";
      else if (i < idx) li.className = "completed";
    }
  }

  function renderDone(result: any): void {
    while (resultHeaderEl.firstChild) resultHeaderEl.removeChild(resultHeaderEl.firstChild);
    const b = document.createElement("strong");
    b.textContent = result.company;
    resultHeaderEl.appendChild(b);
    resultHeaderEl.appendChild(document.createTextNode(" — " + result.role));
    resultHeaderEl.appendChild(document.createElement("br"));
    const s = document.createElement("span");
    s.className = "score";
    s.textContent = result.score.toFixed(1) + "/5";
    resultHeaderEl.appendChild(s);
    resultHeaderEl.appendChild(document.createTextNode(" · " + result.archetype));
    resultTldrEl.textContent = result.tldr;
    show("done");
  }

  function renderError(code: string, message: string): void {
    errorCodeEl.textContent = code;
    errorMessageEl.textContent = message;
    show("error");
  }

  async function loadRecentJobs(): Promise<void> {
    try {
      const res = await sendMsg({ kind: "getRecentJobs", limit: 8 });
      if (!res?.ok || !res.result?.rows?.length) return;
      while (recentListEl.firstChild) recentListEl.removeChild(recentListEl.firstChild);
      for (const row of res.result.rows) {
        const item = document.createElement("div");
        item.className = "recent-item";
        const left = document.createElement("span");
        const c = document.createElement("span"); c.className = "company"; c.textContent = row.company;
        const r = document.createElement("span"); r.className = "role"; r.textContent = row.role;
        left.appendChild(c); left.appendChild(r);
        const sc = document.createElement("span"); sc.className = "score"; sc.textContent = row.score;
        item.appendChild(left); item.appendChild(sc);
        item.addEventListener("click", () => {
          void sendMsg({ kind: "readReport", reportNum: row.num }).then((res: any) => {
            if (res?.ok) void sendMsg({ kind: "openPath", absolutePath: res.result.path });
          });
        });
        recentListEl.appendChild(item);
      }
    } catch { /* silent */ }
  }

  // Wire events
  evaluateBtn.addEventListener("click", () => void onEvaluateClick());
  openReportBtn.addEventListener("click", () => {
    if (currentResult) void sendMsg({ kind: "openPath", absolutePath: currentResult.reportPath });
  });
  retryBtn.addEventListener("click", () => { currentJobId = null; currentResult = null; void runCapture(); });
  setupSaveBtn.addEventListener("click", async () => {
    const token = setupTokenInput.value.trim();
    setupSaveBtn.disabled = true;
    const res = await sendMsg({ kind: "setToken", token });
    setupSaveBtn.disabled = false;
    if (!res?.ok) { renderError(res?.error?.code ?? "BAD_REQUEST", res?.error?.message ?? "failed"); return; }
    setupTokenInput.value = "";
    void refreshHealth();
    await runCapture();
  });
  mergeTrackerBtn.addEventListener("click", async () => {
    mergeTrackerBtn.disabled = true;
    mergeTrackerBtn.textContent = "Merging…";
    const res = await sendMsg({ kind: "mergeTracker", dryRun: false });
    mergeTrackerBtn.disabled = false;
    mergeTrackerBtn.textContent = res?.ok ? "✓ Merged (" + res.result.added + " added)" : "Merge failed";
    if (res?.ok) void loadRecentJobs();
  });

  // Init
  void (async () => {
    const tokenRes = await sendMsg({ kind: "hasToken" });
    if (!tokenRes?.ok || !tokenRes.result?.present) {
      show("setup");
      setupTokenInput.focus();
      return;
    }
    void refreshHealth();
    await runCapture();
    void loadRecentJobs();
  })();
}

/* -------------------------------------------------------------------------- */
/*  Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

function togglePanel(): void {
  const { root, shadow, existed } = getOrCreatePanel();

  if (existed) {
    // Toggle visibility
    root.style.display = root.style.display === "none" ? "block" : "none";
    return;
  }

  // First creation — build the UI
  const style = document.createElement("style");
  style.textContent = buildStyles();
  shadow.appendChild(style);

  const wrapper = document.createElement("div");
  wrapper.insertAdjacentHTML("afterbegin", buildHTML());
  shadow.appendChild(wrapper);

  initPanel(shadow, root);
}

// Listen for toggle messages from the background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === "togglePanel") {
    togglePanel();
  }
});
