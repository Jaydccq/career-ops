import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yaml from "js-yaml";

import {
  extractLinkedInDetail,
  extractLinkedInList,
} from "../extension/src/content/extract-linkedin.ts";
import type {
  EnrichedRow,
  FilteredRow,
  NewGradDetail,
  NewGradEnrichResult,
  NewGradRow,
  NewGradScoreResult,
  PipelineEntry,
  ScoredRow,
} from "../bridge/src/contracts/newgrad.ts";
import type {
  EvaluationInput,
  EvaluationMode,
  EvaluationResult,
  JobSnapshot,
  StructuredJobSignals,
} from "../bridge/src/contracts/jobs.ts";
import {
  buildLinkedInSearchPageUrls,
  detectLinkedInAuthBlock,
  type LinkedInAuthStateInput,
} from "../bridge/src/adapters/linkedin-scan-normalizer.ts";
import {
  loadNegativeKeywords,
  loadNewGradScanConfig,
  loadTrackedCompanyRoles,
} from "../bridge/src/adapters/newgrad-config.ts";
import {
  isRecentNewGradRow,
  loadNewGradSeenKeys,
  newGradCompanyRoleKey,
  wasNewGradRowSeen,
} from "../bridge/src/adapters/newgrad-scan-history.ts";
import { scoreAndFilter } from "../bridge/src/adapters/newgrad-scorer.ts";
import { scoreEnrichedRowValue } from "../bridge/src/adapters/newgrad-value-scorer.ts";
import { pickPipelineEntryUrl } from "../bridge/src/adapters/newgrad-links.ts";

const PROTOCOL_VERSION = "1.0.0";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 47319;
const DEFAULT_PAGE_SIZE = 6;
const SCORE_CHUNK_SIZE = 50;
const ENRICH_CHUNK_SIZE = 3;
const DEFAULT_EVALUATION_QUEUE_DELAY_MS = 2100;
const DEFAULT_EVALUATION_WAIT_TIMEOUT_MS = 20 * 60_000;

type Options = {
  url: string | null;
  bridgeHost: string;
  bridgePort: number;
  limit: number | null;
  pages: number;
  pageSize: number;
  scrollSteps: number;
  enrichLimit: number | null;
  openExternalApply: boolean;
  scoreOnly: boolean;
  evaluate: boolean;
  evaluateLimit: number | null;
  evaluationMode: EvaluationMode;
  waitEvaluations: boolean;
  evaluationQueueDelayMs: number;
  evaluationWaitTimeoutMs: number;
  help: boolean;
};

type BridgeResponse<T> =
  | { ok: true; result: T; requestId: string }
  | { ok: false; error: { code: string; message: string; detail?: unknown }; requestId: string };

type BbJsonEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

type BbOpenData = {
  tabId?: string;
  tab?: string;
  url?: string;
};

type BbTabInfo = {
  index?: number;
  url?: string;
  title?: string;
  active?: boolean;
  tabId?: string;
  tab?: string;
};

type BbTabListData = {
  tabs?: BbTabInfo[];
  activeIndex?: number;
};

type BbEvalData = {
  result?: unknown;
  tab?: string;
};

type ApplyClickResult = {
  status: "not_found" | "easy_apply_skipped" | "clicked" | "external_href" | "clicked_no_url";
  label?: string;
  href?: string;
  beforeUrl?: string;
  afterUrl?: string;
  observedUrls?: string[];
  clicked?: boolean;
};

type ExternalApplyProbeResult = {
  status: ApplyClickResult["status"] | "external_url_found";
  label?: string;
  url: string | null;
  flowUrls: string[];
  clicked: boolean;
};

type ExternalAtsDetail = {
  finalUrl: string;
  title: string;
  company: string;
  location: string;
  workModel: string | null;
  employmentType: string | null;
  salaryRange: string | null;
  description: string;
  responsibilities: string[];
  requiredQualifications: string[];
  skillTags: string[];
};

type EvaluationCreateResult = {
  jobId: string;
  streamUrl: string;
  snapshotUrl: string;
};

type QueuedEvaluation = {
  jobId: string;
  company: string;
  role: string;
};

type FailedEvaluationQueue = {
  company: string;
  role: string;
  error: string;
};

type LinkedInScrollResult = {
  moved: boolean;
  top: number;
  maxTop: number;
  visibleJobs: number;
};

const execFile = promisify(execFileCallback);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function usage(): string {
  return `career-ops LinkedIn scan via bb-browser

Usage:
  npm run linkedin-scan -- --url "<LinkedIn Jobs search URL>" [options]

Options:
  --url <url>                    LinkedIn Jobs search URL. If omitted, reads config/profile.yml -> linkedin_scan.search_url.
  --score-only                   Extract and score rows without bridge write endpoints.
  --no-evaluate                  Stop after bridge enrich/pipeline write; do not queue tracker evaluations.
  --limit <n>                    Limit extracted list rows before scoring.
  --pages <n>                    Number of LinkedIn search result pages to scan using start offsets. Default: 1.
  --page-size <n>                LinkedIn start offset increment for --pages. Default: ${DEFAULT_PAGE_SIZE}.
  --scroll-steps <n>             Per-page result-list scroll probes. Default: 2.
  --enrich-limit <n>             Limit promoted rows before opening detail pages.
  --open-external-apply          Click non-Easy-Apply Apply controls, open the external ATS URL, and read its JD text. Never submits forms.
  --evaluate-limit <n>           Limit enrich survivors sent to /v1/evaluate.
  --evaluation-mode <mode>       Evaluation mode: newgrad_quick or default. Default: newgrad_quick.
  --no-wait-evaluations          Queue evaluation jobs and exit without waiting for tracker merge.
  --evaluation-queue-delay-ms <n>
                                 Delay between /v1/evaluate calls. Default: ${DEFAULT_EVALUATION_QUEUE_DELAY_MS}
  --evaluation-wait-timeout-ms <n>
                                 Max time to wait for queued jobs. Default: ${DEFAULT_EVALUATION_WAIT_TIMEOUT_MS}
  --bridge-host <host>           Bridge host. Default: ${DEFAULT_HOST}
  --bridge-port <port>           Bridge port. Default: ${DEFAULT_PORT}
  --help                         Show this help.

Login recovery:
  If LinkedIn redirects to login or checkpoint, run:
    bb-browser open https://www.linkedin.com/login
  Log in manually in that managed browser, then rerun this command.

Safety:
  This scanner never clicks Easy Apply, Save, Dismiss, or message controls.
  With --open-external-apply, it may click a non-Easy-Apply Apply control, open the external ATS page to read JD text, then stops before any form action.
`;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    url: null,
    bridgeHost: DEFAULT_HOST,
    bridgePort: DEFAULT_PORT,
    limit: null,
    pages: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    scrollSteps: 2,
    enrichLimit: null,
    openExternalApply: false,
    scoreOnly: false,
    evaluate: true,
    evaluateLimit: null,
    evaluationMode: "newgrad_quick",
    waitEvaluations: true,
    evaluationQueueDelayMs: DEFAULT_EVALUATION_QUEUE_DELAY_MS,
    evaluationWaitTimeoutMs: DEFAULT_EVALUATION_WAIT_TIMEOUT_MS,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case "--url":
        options.url = next();
        break;
      case "--score-only":
        options.scoreOnly = true;
        break;
      case "--no-evaluate":
        options.evaluate = false;
        break;
      case "--limit":
        options.limit = positiveInt(next(), arg);
        break;
      case "--pages":
        options.pages = positiveInt(next(), arg);
        break;
      case "--page-size":
        options.pageSize = positiveInt(next(), arg);
        break;
      case "--scroll-steps":
        options.scrollSteps = nonNegativeInt(next(), arg);
        break;
      case "--enrich-limit":
        options.enrichLimit = positiveInt(next(), arg);
        break;
      case "--open-external-apply":
        options.openExternalApply = true;
        break;
      case "--evaluate-limit":
        options.evaluateLimit = positiveInt(next(), arg);
        break;
      case "--evaluation-mode": {
        const mode = next();
        if (mode !== "newgrad_quick" && mode !== "default") {
          throw new Error("--evaluation-mode must be newgrad_quick or default");
        }
        options.evaluationMode = mode;
        break;
      }
      case "--no-wait-evaluations":
        options.waitEvaluations = false;
        break;
      case "--evaluation-queue-delay-ms":
        options.evaluationQueueDelayMs = nonNegativeInt(next(), arg);
        break;
      case "--evaluation-wait-timeout-ms":
        options.evaluationWaitTimeoutMs = positiveInt(next(), arg);
        break;
      case "--bridge-host":
        options.bridgeHost = next();
        break;
      case "--bridge-port":
        options.bridgePort = positiveInt(next(), arg);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

function positiveInt(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInt(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const url = options.url ?? await readConfiguredSearchUrl();
  if (!url) {
    throw new Error("missing LinkedIn search URL; pass --url or set config/profile.yml -> linkedin_scan.search_url");
  }

  await assertBbBrowserAvailable();
  const token = (await readFile(join(repoRoot, "bridge", ".bridge-token"), "utf8")).trim();
  const bridgeBase = `http://${options.bridgeHost}:${options.bridgePort}`;
  await assertBridgeHealthy(bridgeBase, token);

  const collected = await collectLinkedInRows(url, options);
  let rows = dedupeRows(collected.rows);
  if (options.limit !== null) rows = rows.slice(0, options.limit);
  console.log(`Extracted ${collected.rows.length} raw LinkedIn rows; ${rows.length} unique after dedupe`);

  if (rows.length === 0) {
    console.log("No rows extracted; check the LinkedIn page filters or login state.");
    return;
  }

  const score = options.scoreOnly
    ? scoreRowsLocally(rows)
    : await scoreRows(bridgeBase, token, rows);
  console.log(`Scored rows: promoted=${score.promoted.length}, filtered=${score.filtered.length}`);
  printPromotedRows(score.promoted);

  if (options.scoreOnly || score.promoted.length === 0) {
    if (options.scoreOnly) {
      console.log("--score-only used: no bridge write endpoints were called.");
    }
    return;
  }

  const promoted = options.enrichLimit === null
    ? [...score.promoted]
    : [...score.promoted].slice(0, options.enrichLimit);
  console.log(`Enriching ${promoted.length} promoted LinkedIn rows`);

  const { enrichedRows, failed } = await enrichLinkedInDetails(promoted, options);
  console.log(`Detail enrichment: enriched=${enrichedRows.length}, failed=${failed}`);
  if (enrichedRows.length === 0) return;

  const enrich = await writeEnrichedRows(bridgeBase, token, enrichedRows);
  console.log(`Bridge enrich result: added=${enrich.added}, skipped=${enrich.skipped}, candidates=${enrich.candidates?.length ?? 0}`);
  if (enrich.skipBreakdown && Object.keys(enrich.skipBreakdown).length > 0) {
    console.log(`Skip breakdown: ${JSON.stringify(enrich.skipBreakdown)}`);
  }
  printPipelineEntries(enrich.entries);

  if (!options.evaluate) {
    console.log("Direct evaluation disabled by --no-evaluate.");
    return;
  }

  const bridgeCandidates = [...(enrich.candidates ?? enrich.entries)];
  const reviewCandidates = buildLinkedInReviewCandidates(enrichedRows, bridgeCandidates);
  if (reviewCandidates.length > 0) {
    console.log(`LinkedIn review fallback: ${reviewCandidates.length} value-threshold rows eligible for direct evaluation`);
  }

  const evaluationCandidates = dedupePipelineEntries([
    ...bridgeCandidates,
    ...reviewCandidates,
  ]).slice(
    0,
    options.evaluateLimit ?? undefined,
  );
  if (evaluationCandidates.length === 0) {
    console.log("No enrich survivors eligible for direct evaluation.");
    return;
  }

  const queued = await queueDirectEvaluations(
    bridgeBase,
    token,
    evaluationCandidates,
    enrichedRows,
    options,
  );
  console.log(`Direct evaluation queue: queued=${queued.jobs.length}, failed=${queued.failed.length}, skipped=${queued.skipped}`);
  for (const failedJob of queued.failed) {
    console.warn(`- failed to queue ${failedJob.company} - ${failedJob.role}: ${failedJob.error}`);
  }

  if (options.waitEvaluations && queued.jobs.length > 0) {
    const result = await waitForEvaluations(bridgeBase, token, queued.jobs, options);
    console.log(`Direct evaluation result: completed=${result.completed.length}, failed=${result.failed.length}, timedOut=${result.timedOut.length}`);
    for (const item of result.completed) {
      console.log(`- ${item.result.company} - ${item.result.role}: ${item.result.score}/5 report=${item.result.reportPath} trackerMerged=${item.result.trackerMerged}`);
    }
  } else if (queued.jobs.length > 0) {
    console.log("Evaluation jobs queued; not waiting because --no-wait-evaluations was set.");
  }
}

async function collectLinkedInRows(
  url: string,
  options: Options,
): Promise<{ rows: NewGradRow[] }> {
  const pageUrls = buildLinkedInSearchPageUrls(url, options.pages, options.pageSize);
  const rows: NewGradRow[] = [];

  for (const [index, pageUrl] of pageUrls.entries()) {
    const listTabId = await openBbTab(pageUrl);
    try {
      await assertLinkedInReady(listTabId);
      await waitForLinkedInSearchContent(listTabId);
      let pageRows = await collectLinkedInPageRows(listTabId, options);
      if (pageRows.length === 0) {
        await sleep(1_500);
        await waitForLinkedInSearchContent(listTabId);
        pageRows = await collectLinkedInPageRows(listTabId, options);
      }
      rows.push(...pageRows);
      const uniqueSoFar = dedupeRows(rows).length;
      console.log(`Page ${index + 1}/${pageUrls.length}: extracted ${pageRows.length} raw rows (${uniqueSoFar} unique so far)`);

      if (options.limit !== null && uniqueSoFar >= options.limit) {
        break;
      }
    } finally {
      await closeBbTab(listTabId);
    }
  }

  return { rows };
}

async function waitForLinkedInSearchContent(tabId: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await evaluateBrowserJson<{
      url: string;
      title: string;
      text: string;
      dataJobCount: number;
      jobLinkCount: number;
      currentJobId: string | null;
    }>(tabId, linkedInSearchContentState);

    if (
      state.dataJobCount > 0 ||
      (
        Boolean(state.currentJobId) &&
        state.jobLinkCount > 0 &&
        /\b\d+\s+results?\b/i.test(state.text)
      )
    ) {
      return;
    }

    await sleep(750);
  }
}

function linkedInSearchContentState(): {
  url: string;
  title: string;
  text: string;
  dataJobCount: number;
  jobLinkCount: number;
  currentJobId: string | null;
} {
  const url = window.location.href;
  return {
    url,
    title: document.title,
    text: (document.body?.innerText ?? "").slice(0, 4_000),
    dataJobCount: document.querySelectorAll("[data-job-id]").length,
    jobLinkCount: document.querySelectorAll("a[href*='/jobs/view/']").length,
    currentJobId: new URL(url).searchParams.get("currentJobId"),
  };
}

async function collectLinkedInPageRows(tabId: string, options: Options): Promise<NewGradRow[]> {
  const rows: NewGradRow[] = [];

  for (let step = 0; step <= options.scrollSteps; step += 1) {
    rows.push(...await evaluateBrowserJson<NewGradRow[]>(tabId, extractLinkedInList));
    if (step === options.scrollSteps) break;

    const scroll = await evaluateBrowserJson<LinkedInScrollResult>(tabId, advanceLinkedInResultsScroll);
    if (!scroll.moved) break;
    await sleep(350);
  }

  return rows;
}

function advanceLinkedInResultsScroll(): LinkedInScrollResult {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    [
      ".scaffold-layout__list",
      ".scaffold-layout__list-container",
      ".jobs-search-results-list",
      ".jobs-search-results-list__list",
      "[class*='jobs-search-results']",
      "[aria-label*='Jobs Search Results']",
      "main",
    ].join(", "),
  ));
  const target = candidates
    .filter((node) => node.scrollHeight > node.clientHeight + 120 && Boolean(node.querySelector("[data-job-id]")))
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];

  if (!target) {
    return {
      moved: false,
      top: 0,
      maxTop: 0,
      visibleJobs: document.querySelectorAll("[data-job-id]").length,
    };
  }

  const previousTop = target.scrollTop;
  const maxTop = Math.max(0, target.scrollHeight - target.clientHeight);
  const nextTop = Math.min(
    previousTop + Math.max(500, Math.floor(target.clientHeight * 0.85)),
    maxTop,
  );
  target.scrollTo({ top: nextTop, behavior: "auto" });

  return {
    moved: target.scrollTop !== previousTop,
    top: target.scrollTop,
    maxTop,
    visibleJobs: target.querySelectorAll("[data-job-id]").length,
  };
}

async function readConfiguredSearchUrl(): Promise<string | null> {
  const profilePath = join(repoRoot, "config", "profile.yml");
  if (!existsSync(profilePath)) return null;
  const parsed = yaml.load(await readFile(profilePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") return null;
  const profile = parsed as { linkedin_scan?: { search_url?: unknown } };
  const value = profile.linkedin_scan?.search_url;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function assertBbBrowserAvailable(): Promise<void> {
  try {
    await execFile("bb-browser", ["--version"], { maxBuffer: 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`bb-browser is not available on PATH: ${message}`);
  }
}

async function openBbTab(url: string): Promise<string> {
  const data = await runBbJson<BbOpenData>(["open", url, "--json", "--tab"]);
  if (!data.tabId) {
    throw new Error(`bb-browser open did not return a tab id for ${url}`);
  }
  await sleep(2_000);
  return data.tabId;
}

async function closeBbTab(tabId: string): Promise<void> {
  await runBb(["close", "--tab", tabId]).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to close bb-browser tab ${tabId}: ${message}`);
  });
}

async function listBbTabs(): Promise<BbTabInfo[]> {
  const data = await runBbJson<BbTabListData>(["tab", "list", "--json"]);
  return data.tabs ?? [];
}

async function evaluateBrowserJson<T>(tabId: string, func: () => unknown | Promise<unknown>): Promise<T> {
  const script = `(() => { const __name = (target) => target; return (async () => JSON.stringify(await (${func.toString()})()))(); })()`;
  const data = await runBbJson<BbEvalData>(["eval", script, "--json", "--tab", tabId]);
  const result = data.result;
  if (typeof result === "string") return JSON.parse(result) as T;
  return result as T;
}

async function assertLinkedInReady(tabId: string): Promise<void> {
  const state = await evaluateBrowserJson<LinkedInAuthStateInput>(tabId, pageStateForAuth);
  const block = detectLinkedInAuthBlock(state);
  if (!block) return;

  throw new Error(
    `LinkedIn ${block} page detected. Run "bb-browser open https://www.linkedin.com/login", log in manually, then rerun linkedin-scan.`,
  );
}

function pageStateForAuth(): LinkedInAuthStateInput {
  return {
    url: window.location.href,
    title: document.title,
    text: (document.body?.innerText ?? "").slice(0, 3000),
  };
}

async function runBb(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile("bb-browser", [...args], {
      maxBuffer: 25 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const detail = [err.message, err.stderr, err.stdout].filter(Boolean).join("\n");
    throw new Error(detail);
  }
}

async function runBbJson<T>(args: readonly string[]): Promise<T> {
  const { stdout } = await runBb(args);
  const envelope = JSON.parse(stdout) as BbJsonEnvelope<T>;
  if (!envelope.success) {
    throw new Error(envelope.error ?? "bb-browser command failed");
  }
  if (envelope.data === undefined) {
    throw new Error("bb-browser JSON response had no data");
  }
  return envelope.data;
}

async function assertBridgeHealthy(base: string, token: string): Promise<void> {
  const result = await getEnvelope<unknown>(base, token, "/v1/health");
  void result;
  console.log("Bridge health: ok");
}

function scoreRowsLocally(rows: NewGradRow[]): NewGradScoreResult {
  const scanConfig = loadNewGradScanConfig(repoRoot);
  const negativeKeywords = loadNegativeKeywords(repoRoot);
  const trackedSet = loadTrackedCompanyRoles(repoRoot);
  const seenKeys = loadNewGradSeenKeys(repoRoot);
  const recentUnseenRows: NewGradRow[] = [];
  const preFiltered: FilteredRow[] = [];

  for (const row of rows) {
    if (!isRecentNewGradRow(row)) {
      preFiltered.push({
        row,
        reason: "older_than_24h",
        detail: `Posted ${row.postedAgo || "outside the last 24h"}`,
      });
      continue;
    }

    const trackedKey = newGradCompanyRoleKey(row);
    if (trackedKey && trackedSet.has(trackedKey)) {
      preFiltered.push({
        row,
        reason: "already_tracked",
        detail: `Already tracked: ${row.company} | ${row.title}`,
      });
      continue;
    }

    if (wasNewGradRowSeen(row, seenKeys)) {
      preFiltered.push({
        row,
        reason: "already_scanned",
        detail: "Already seen in scan history or pipeline",
      });
      continue;
    }

    recentUnseenRows.push(row);
  }

  const { promoted, filtered } = scoreAndFilter(
    recentUnseenRows,
    scanConfig,
    negativeKeywords,
    trackedSet,
  );
  return { promoted, filtered: [...preFiltered, ...filtered] };
}

async function scoreRows(
  bridgeBase: string,
  token: string,
  rows: NewGradRow[],
): Promise<NewGradScoreResult> {
  const promoted: ScoredRow[] = [];
  const filtered: FilteredRow[] = [];

  for (let start = 0; start < rows.length; start += SCORE_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + SCORE_CHUNK_SIZE);
    const res = await postEnvelope<NewGradScoreResult>(
      bridgeBase,
      token,
      "/v1/newgrad-scan/score",
      { rows: chunk },
    );
    promoted.push(...res.promoted);
    filtered.push(...res.filtered);
  }

  return {
    promoted: promoted.sort((a, b) => b.score - a.score),
    filtered,
  };
}

async function enrichLinkedInDetails(
  promotedRows: readonly ScoredRow[],
  options: Options,
): Promise<{ enrichedRows: EnrichedRow[]; failed: number }> {
  const enrichedRows: EnrichedRow[] = [];
  let failed = 0;

  for (const scored of promotedRows) {
    const detailTabId = await openBbTab(scored.row.detailUrl);
    try {
      await assertLinkedInReady(detailTabId);
      const rawDetail = await evaluateBrowserJson<NewGradDetail>(detailTabId, extractLinkedInDetail);
      const externalApply = options.openExternalApply
        ? await probeExternalApplyUrl(detailTabId)
        : null;
      const externalDetail = externalApply?.url
        ? await readExternalAtsDetail(externalApply.url)
        : null;
      if (externalApply) {
        const label = externalApply.label ? ` (${externalApply.label})` : "";
        if (externalApply.url) {
          console.log(`External Apply URL${label}: ${scored.row.company} - ${scored.row.title}: ${externalApply.url}`);
          if (externalDetail?.description) {
            console.log(`External ATS detail: ${externalDetail.description.length} chars from ${externalDetail.finalUrl}`);
          }
        } else {
          console.log(`External Apply probe ${externalApply.status}${label}: ${scored.row.company} - ${scored.row.title}`);
        }
      }
      const mergedDetail = mergeExternalAtsDetail(rawDetail, externalDetail);
      const detail: NewGradDetail = {
        ...mergedDetail,
        position: scored.row.position,
        title: mergedDetail.title || scored.row.title,
        company: mergedDetail.company || scored.row.company,
        location: mergedDetail.location || scored.row.location,
        workModel: mergedDetail.workModel || scored.row.workModel || null,
        salaryRange: mergedDetail.salaryRange || scored.row.salary,
        originalPostUrl: mergedDetail.originalPostUrl || scored.row.detailUrl,
        applyNowUrl: externalApply?.url || rawDetail.applyNowUrl || scored.row.applyUrl,
        applyFlowUrls: Array.from(new Set([
          ...(externalApply?.flowUrls ?? []),
          ...(externalApply?.url ? [externalApply.url] : []),
          ...(mergedDetail.applyFlowUrls ?? []),
          scored.row.detailUrl,
        ])),
      };
      enrichedRows.push({ row: scored, detail });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Detail enrichment failed for ${scored.row.company} - ${scored.row.title}: ${message}`);
    } finally {
      await closeBbTab(detailTabId);
    }
  }

  return { enrichedRows, failed };
}

async function readExternalAtsDetail(url: string): Promise<ExternalAtsDetail | null> {
  const tabId = await openBbTab(url);
  try {
    await sleep(3_500);
    const detail = await evaluateBrowserJson<ExternalAtsDetail>(tabId, extractExternalAtsJobDetail);
    return detail.description.trim().length >= 200 ? detail : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`External ATS detail read failed for ${url}: ${message}`);
    return null;
  } finally {
    await closeBbTab(tabId);
  }
}

function mergeExternalAtsDetail(
  linkedIn: NewGradDetail,
  external: ExternalAtsDetail | null,
): NewGradDetail {
  if (!external?.description) return linkedIn;

  const externalSection = [
    `External ATS URL: ${external.finalUrl}`,
    external.description,
  ].filter(Boolean).join("\n\n");
  const linkedInSection = linkedIn.description
    ? `LinkedIn detail excerpt:\n${linkedIn.description}`
    : "";
  const description = [
    externalSection,
    linkedInSection,
  ].filter(Boolean).join("\n\n---\n\n").slice(0, 30_000);

  return {
    ...linkedIn,
    title: linkedIn.title || external.title,
    company: linkedIn.company || external.company,
    location: external.location || linkedIn.location,
    employmentType: external.employmentType || linkedIn.employmentType,
    workModel: external.workModel || linkedIn.workModel,
    salaryRange: external.salaryRange || linkedIn.salaryRange,
    description,
    responsibilities: uniqueStrings([
      ...external.responsibilities,
      ...linkedIn.responsibilities,
    ]).slice(0, 20),
    requiredQualifications: uniqueStrings([
      ...external.requiredQualifications,
      ...linkedIn.requiredQualifications,
    ]).slice(0, 20),
    skillTags: uniqueStrings([
      ...external.skillTags,
      ...linkedIn.skillTags,
    ]).slice(0, 30),
    applyNowUrl: external.finalUrl || linkedIn.applyNowUrl,
    applyFlowUrls: uniqueStrings([
      external.finalUrl,
      ...linkedIn.applyFlowUrls,
    ]),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

async function extractExternalAtsJobDetail(): Promise<ExternalAtsDetail> {
  function text(el: Element | null | undefined): string {
    if (!el) return "";
    return ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
  }

  function compact(value: string): string {
    return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  }

  function firstText(...selectors: string[]): string {
    for (const selector of selectors) {
      const value = compact(text(document.querySelector(selector)));
      if (value) return value;
    }
    return "";
  }

  function meta(name: string): string {
    return compact(
      document.querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`)?.content ?? "",
    );
  }

  function cleanLines(value: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of value.split(/\r?\n/)) {
      const line = compact(raw);
      if (!line) continue;
      if (/^(apply|apply now|save|share|sign in|log in|create alert|back to search|view all jobs)$/i.test(line)) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  }

  function sectionItems(source: string, headingPattern: RegExp): string[] {
    const sourceLines = cleanLines(source);
    const start = sourceLines.findIndex((line) => headingPattern.test(line));
    if (start === -1) return [];

    const items: string[] = [];
    for (const line of sourceLines.slice(start + 1)) {
      if (/^(benefits|qualifications|requirements|responsibilities|skills|about|what you|you will|who you are|preferred)$/i.test(line)) {
        if (items.length > 0) break;
        continue;
      }
      const cleaned = compact(line.replace(/^[-•*]\s*/, ""));
      if (cleaned.length < 20 || cleaned.length > 500) continue;
      items.push(cleaned);
      if (items.length >= 12) break;
    }
    return items;
  }

  function salaryFromText(value: string): string | null {
    const match = compact(value).match(
      /\$\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s*(?:k|K)?\s*(?:\/\s?(?:yr|year|hr|hour))?\s*[-–]\s*\$\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s*(?:k|K)?(?:\s*\/\s?(?:yr|year|hr|hour))?/i,
    );
    return match?.[0] ? compact(match[0]) : null;
  }

  function workModelFromText(value: string): string | null {
    if (/\bremote\b/i.test(value)) return "Remote";
    if (/\bhybrid\b/i.test(value)) return "Hybrid";
    if (/\b(on-site|onsite)\b/i.test(value)) return "On-site";
    return null;
  }

  function skillTagsFromText(value: string): string[] {
    const skills = [
      "TypeScript",
      "JavaScript",
      "Python",
      "React",
      "Node.js",
      "Java",
      "Go",
      "C++",
      "SQL",
      "AWS",
      "Azure",
      "GCP",
      "Kubernetes",
      "Docker",
      "LLM",
      "AI",
      "Machine Learning",
      "Spring",
      "Kafka",
    ];
    const normalized = value.toLowerCase();
    return skills.filter((skill) => normalized.includes(skill.toLowerCase())).slice(0, 18);
  }

  const bodyText = compact(document.body?.innerText ?? "");
  const descriptionSource = firstText(
    "[data-automation-id='jobPostingDescription']",
    "[data-testid='job-description']",
    "[class*='ats-description']",
    "[class*='atsDescription']",
    "[class*='job-description']",
    "[class*='jobDescription']",
    "[class*='description']",
    "article",
    "main",
  ) || bodyText;
  const description = cleanLines(descriptionSource).join("\n").slice(0, 30_000);
  const title = firstText("h1", "[data-automation-id='jobPostingHeader']", "[class*='job-title']", "[class*='jobTitle']") ||
    meta("og:title") ||
    document.title;
  const company = firstText("[data-automation-id='company']", "[class*='company']") || meta("og:site_name");
  const location = firstText("[data-automation-id='locations']", "[class*='location']", "[class*='Location']");

  return {
    finalUrl: window.location.href,
    title: compact(title),
    company: compact(company),
    location: compact(location),
    workModel: workModelFromText(description || bodyText),
    employmentType: /\b(full[-\s]?time|part[-\s]?time|internship|contract)\b/i.exec(description || bodyText)?.[0] ?? null,
    salaryRange: salaryFromText(description || bodyText),
    description,
    responsibilities: sectionItems(description, /^(responsibilities|what you will do|you will|role responsibilities|about the role)$/i),
    requiredQualifications: sectionItems(description, /^(qualifications|requirements|basic qualifications|required qualifications|what you bring)$/i),
    skillTags: skillTagsFromText(description || bodyText),
  };
}

async function probeExternalApplyUrl(tabId: string): Promise<ExternalApplyProbeResult> {
  const beforeTabs = await listBbTabs();
  const beforeIds = new Set(beforeTabs.map((tab) => tab.tabId).filter((id): id is string => Boolean(id)));
  const click = await evaluateBrowserJson<ApplyClickResult>(tabId, clickLinkedInExternalApplyButton);
  const flowUrls = new Set<string>();

  addCandidateApplyUrls(flowUrls, click.href);
  addCandidateApplyUrls(flowUrls, click.afterUrl);
  for (const url of click.observedUrls ?? []) {
    addCandidateApplyUrls(flowUrls, url);
  }

  const openedTabs = new Map<string, BbTabInfo>();
  if (click.clicked) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const tabs = await listBbTabs();
      for (const tab of tabs) {
        if (!tab.tabId || beforeIds.has(tab.tabId)) continue;
        openedTabs.set(tab.tabId, tab);
        addCandidateApplyUrls(flowUrls, tab.url);
      }
      if (flowUrls.size > 0) break;
      await sleep(750);
    }
  }

  for (const tab of openedTabs.values()) {
    if (tab.tabId) await closeBbTab(tab.tabId);
  }

  const urls = [...flowUrls];
  return {
    status: urls.length > 0 ? "external_url_found" : click.status,
    label: click.label,
    url: urls[0] ?? null,
    flowUrls: urls,
    clicked: Boolean(click.clicked),
  };
}

function addCandidateApplyUrls(target: Set<string>, raw: string | null | undefined): void {
  const url = normalizeUrl(raw);
  if (!url) return;
  if (isUsefulExternalApplyUrl(url)) {
    target.add(url);
  }

  for (const nested of nestedExternalUrls(url)) {
    target.add(nested);
  }
}

function isUsefulExternalApplyUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    return false;
  }
  return true;
}

function nestedExternalUrls(raw: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return [];
  }

  const urls: string[] = [];
  for (const value of parsed.searchParams.values()) {
    const decoded = decodeURIComponent(value);
    const nested = normalizeUrl(decoded);
    if (nested && isUsefulExternalApplyUrl(nested)) {
      urls.push(nested);
    }
  }
  return urls;
}

async function clickLinkedInExternalApplyButton(): Promise<ApplyClickResult> {
  function compact(value: string): string {
    return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  }

  function labelFor(el: Element): string {
    const html = el as HTMLElement;
    return compact([
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("title") ?? "",
      html.innerText ?? el.textContent ?? "",
    ].filter(Boolean).join(" "));
  }

  function isVisible(el: Element): boolean {
    const html = el as HTMLElement;
    const rect = html.getBoundingClientRect();
    const style = window.getComputedStyle(html);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      !html.hasAttribute("disabled") &&
      el.getAttribute("aria-disabled") !== "true";
  }

  function hrefFor(el: Element): string {
    const anchor = el instanceof HTMLAnchorElement ? el : el.closest<HTMLAnchorElement>("a[href]");
    if (!anchor?.href) return "";
    try {
      const parsed = new URL(anchor.href, window.location.href);
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "";
    }
  }

  function resourceUrls(): string[] {
    return performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter(Boolean)
      .slice(-200);
  }

  const controls = Array.from(document.querySelectorAll<HTMLElement>("button, a[href]"))
    .filter(isVisible)
    .map((el) => ({ el, label: labelFor(el), href: hrefFor(el) }))
    .filter((item) => /\bapply\b/i.test(item.label));

  const easyApply = controls.find((item) => /\beasy\s+apply\b/i.test(item.label));
  const candidates = controls
    .filter((item) => !/\beasy\s+apply\b/i.test(item.label))
    .filter((item) => /\bapply\b/i.test(item.label) && !/\b(applied|applicants?)\b/i.test(item.label))
    .sort((a, b) => {
      const aTopCard = a.el.closest(".job-details-jobs-unified-top-card, .jobs-unified-top-card") ? 1 : 0;
      const bTopCard = b.el.closest(".job-details-jobs-unified-top-card, .jobs-unified-top-card") ? 1 : 0;
      return bTopCard - aTopCard;
    });

  const candidate = candidates[0];
  if (!candidate) {
    return easyApply
      ? { status: "easy_apply_skipped", label: easyApply.label, clicked: false }
      : { status: "not_found", clicked: false };
  }

  const beforeUrl = window.location.href;
  const beforeResources = new Set(resourceUrls());
  if (candidate.href && !/linkedin\.com\/jobs\/view\//i.test(candidate.href)) {
    candidate.el.scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    candidate.el.click();
    await new Promise((resolve) => window.setTimeout(resolve, 2500));
    return {
      status: "external_href",
      label: candidate.label,
      href: candidate.href,
      beforeUrl,
      afterUrl: window.location.href,
      observedUrls: resourceUrls().filter((url) => !beforeResources.has(url)).slice(0, 100),
      clicked: true,
    };
  }

  candidate.el.scrollIntoView({ block: "center", inline: "center" });
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  candidate.el.click();
  await new Promise((resolve) => window.setTimeout(resolve, 2500));

  const afterUrl = window.location.href;
  return {
    status: beforeUrl !== afterUrl ? "clicked" : "clicked_no_url",
    label: candidate.label,
    href: candidate.href,
    beforeUrl,
    afterUrl,
    observedUrls: resourceUrls().filter((url) => !beforeResources.has(url)).slice(0, 100),
    clicked: true,
  };
}

async function writeEnrichedRows(
  bridgeBase: string,
  token: string,
  rows: EnrichedRow[],
): Promise<NewGradEnrichResult> {
  const merged: NewGradEnrichResult = {
    added: 0,
    skipped: 0,
    skipBreakdown: {},
    entries: [],
    candidates: [],
  };

  for (let start = 0; start < rows.length; start += ENRICH_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + ENRICH_CHUNK_SIZE).map(truncateEnrichedRow);
    const result = await postEnvelope<NewGradEnrichResult>(
      bridgeBase,
      token,
      "/v1/newgrad-scan/enrich",
      { rows: chunk },
    );
    merged.added += result.added;
    merged.skipped += result.skipped;
    merged.entries = [...merged.entries, ...result.entries];
    merged.candidates = [
      ...(merged.candidates ?? []),
      ...(result.candidates ?? result.entries),
    ];
    mergeCounts(merged.skipBreakdown, result.skipBreakdown);
  }

  return merged;
}

async function queueDirectEvaluations(
  bridgeBase: string,
  token: string,
  candidates: readonly PipelineEntry[],
  enrichedRows: readonly EnrichedRow[],
  options: Options,
): Promise<{ jobs: QueuedEvaluation[]; failed: FailedEvaluationQueue[]; skipped: number }> {
  const jobs: QueuedEvaluation[] = [];
  const failed: FailedEvaluationQueue[] = [];
  let skipped = 0;
  const seen = new Set<string>();

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const key = normalizeUrl(candidate.url) ?? `${normalizeText(candidate.company)}|${normalizeText(candidate.role)}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);

    const matchedRow = findEnrichedRowForCandidate(candidate, enrichedRows);
    const input = buildEvaluationInput(candidate, matchedRow, options.evaluationMode);
    console.log(`Queueing direct evaluation ${index + 1}/${candidates.length}: ${candidate.company} - ${candidate.role}`);

    try {
      const created = await postEnvelope<EvaluationCreateResult>(
        bridgeBase,
        token,
        "/v1/evaluate",
        { input },
      );
      jobs.push({
        jobId: created.jobId,
        company: candidate.company,
        role: candidate.role,
      });
    } catch (error) {
      failed.push({
        company: candidate.company,
        role: candidate.role,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (index < candidates.length - 1 && options.evaluationQueueDelayMs > 0) {
      await sleep(options.evaluationQueueDelayMs);
    }
  }

  return { jobs, failed, skipped };
}

function buildEvaluationInput(
  candidate: PipelineEntry,
  matchedRow: EnrichedRow | undefined,
  evaluationMode: EvaluationMode,
): EvaluationInput {
  const structuredSignals = buildStructuredSignals(candidate, matchedRow);
  const pageText = buildEvaluationPageText(candidate, matchedRow);
  return {
    url: candidate.url,
    title: candidate.role,
    evaluationMode,
    structuredSignals,
    detection: {
      label: "job_posting",
      confidence: 1,
      signals: ["linkedin-scan"],
    },
    ...(pageText ? { pageText } : {}),
  };
}

function buildStructuredSignals(
  candidate: PipelineEntry,
  matchedRow: EnrichedRow | undefined,
): StructuredJobSignals {
  if (!matchedRow) {
    return {
      source: candidate.source,
      company: candidate.company,
      role: candidate.role,
      ...(candidate.valueScore !== undefined ? { localValueScore: candidate.valueScore } : {}),
      ...(candidate.valueReasons && candidate.valueReasons.length > 0
        ? { localValueReasons: signalStrings(candidate.valueReasons, 16, 120) }
        : {}),
    };
  }

  const { detail, row } = matchedRow;
  return {
    source: candidate.source,
    company: detail.company || candidate.company,
    role: detail.title || candidate.role,
    ...(detail.location || row.row.location ? { location: detail.location || row.row.location } : {}),
    ...(detail.workModel || row.row.workModel ? { workModel: detail.workModel || row.row.workModel } : {}),
    ...(detail.employmentType ? { employmentType: detail.employmentType } : {}),
    ...(detail.seniorityLevel ? { seniority: detail.seniorityLevel } : {}),
    ...(row.row.postedAgo ? { postedAgo: row.row.postedAgo } : {}),
    ...(detail.salaryRange || row.row.salary ? { salaryRange: detail.salaryRange || row.row.salary || undefined } : {}),
    sponsorshipSupport: detail.confirmedSponsorshipSupport !== "unknown"
      ? detail.confirmedSponsorshipSupport
      : detail.sponsorshipSupport !== "unknown"
        ? detail.sponsorshipSupport
        : row.row.sponsorshipSupport,
    requiresActiveSecurityClearance:
      detail.confirmedRequiresActiveSecurityClearance ||
      detail.requiresActiveSecurityClearance ||
      row.row.requiresActiveSecurityClearance,
    ...(extractYearsExperienceRequired([detail.requiredQualifications.join(" "), detail.description].join("\n")) !== null
      ? { yearsExperienceRequired: extractYearsExperienceRequired([detail.requiredQualifications.join(" "), detail.description].join("\n")) }
      : {}),
    ...(detail.companySize || row.row.companySize ? { companySize: detail.companySize || row.row.companySize } : { companySize: null }),
    taxonomy: signalStrings(detail.taxonomy, 10, 120),
    recommendationTags: signalStrings(detail.recommendationTags, 10, 120),
    skillTags: signalStrings(detail.skillTags, 14, 120),
    requiredQualifications: signalStrings(detail.requiredQualifications, 10, 400),
    responsibilities: signalStrings(detail.responsibilities, 8, 400),
    ...(candidate.valueScore !== undefined ? { localValueScore: candidate.valueScore } : {}),
    ...(candidate.valueReasons && candidate.valueReasons.length > 0
      ? { localValueReasons: signalStrings(candidate.valueReasons, 16, 120) }
      : {}),
  };
}

function buildEvaluationPageText(
  candidate: PipelineEntry,
  matchedRow: EnrichedRow | undefined,
): string | undefined {
  if (!matchedRow) return undefined;

  const { detail, row } = matchedRow;
  const sections = [
    `URL: ${candidate.url}`,
    `Company: ${detail.company || candidate.company}`,
    `Role: ${detail.title || candidate.role}`,
    detail.location || row.row.location ? `Location: ${detail.location || row.row.location}` : null,
    detail.workModel || row.row.workModel ? `Work model: ${detail.workModel || row.row.workModel}` : null,
    detail.employmentType ? `Employment type: ${detail.employmentType}` : null,
    detail.seniorityLevel ? `Seniority: ${detail.seniorityLevel}` : null,
    detail.salaryRange || row.row.salary ? `Salary: ${detail.salaryRange || row.row.salary}` : null,
    `Local newgrad score: ${candidate.score}`,
    candidate.valueScore !== undefined ? `Local enrich value score: ${candidate.valueScore}/10` : null,
    candidate.valueReasons && candidate.valueReasons.length > 0
      ? `Local enrich reasons: ${candidate.valueReasons.join(", ")}`
      : null,
    detail.skillTags.length > 0 ? `Skill tags: ${detail.skillTags.slice(0, 15).join(", ")}` : null,
    detail.requiredQualifications.length > 0
      ? ["Requirements:", ...detail.requiredQualifications.slice(0, 10).map((item) => `- ${item}`)].join("\n")
      : null,
    detail.responsibilities.length > 0
      ? ["Responsibilities:", ...detail.responsibilities.slice(0, 8).map((item) => `- ${item}`)].join("\n")
      : null,
    detail.description ? `Description excerpt:\n${detail.description.slice(0, 2200)}` : null,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n")
    .trim();

  return sections.length > 0 ? sections.slice(0, 4_000) : undefined;
}

function findEnrichedRowForCandidate(
  candidate: PipelineEntry,
  rows: readonly EnrichedRow[],
): EnrichedRow | undefined {
  const candidateUrl = normalizeUrl(candidate.url);
  if (candidateUrl) {
    const byUrl = rows.find((row) =>
      [
        row.row.row.detailUrl,
        row.row.row.applyUrl,
        row.detail.originalPostUrl,
        row.detail.applyNowUrl,
        ...row.detail.applyFlowUrls,
      ].some((url) => normalizeUrl(url) === candidateUrl),
    );
    if (byUrl) return byUrl;
  }

  const candidateKey = `${normalizeText(candidate.company)}|${normalizeText(candidate.role)}`;
  return rows.find((row) => {
    const company = row.detail.company || row.row.row.company;
    const role = row.detail.title || row.row.row.title;
    return `${normalizeText(company)}|${normalizeText(role)}` === candidateKey;
  });
}

async function waitForEvaluations(
  bridgeBase: string,
  token: string,
  jobs: readonly QueuedEvaluation[],
  options: Options,
): Promise<{
  completed: Array<{ job: QueuedEvaluation; result: EvaluationResult }>;
  failed: Array<{ job: QueuedEvaluation; error: string }>;
  timedOut: QueuedEvaluation[];
}> {
  const pending = new Map(jobs.map((job) => [job.jobId, job]));
  const completed: Array<{ job: QueuedEvaluation; result: EvaluationResult }> = [];
  const failed: Array<{ job: QueuedEvaluation; error: string }> = [];
  const deadline = Date.now() + options.evaluationWaitTimeoutMs;

  while (pending.size > 0 && Date.now() < deadline) {
    for (const [jobId, job] of Array.from(pending.entries())) {
      const snapshot = await getEnvelope<JobSnapshot>(bridgeBase, token, `/v1/jobs/${jobId}`);
      if (snapshot.phase === "completed" && snapshot.result) {
        completed.push({ job, result: snapshot.result });
        pending.delete(jobId);
      } else if (snapshot.phase === "failed" && snapshot.error) {
        failed.push({ job, error: `${snapshot.error.code} ${snapshot.error.message}` });
        pending.delete(jobId);
      }
    }

    if (pending.size > 0) {
      console.log(`Waiting for evaluations: completed=${completed.length}, failed=${failed.length}, pending=${pending.size}`);
      await sleep(5_000);
    }
  }

  return {
    completed,
    failed,
    timedOut: Array.from(pending.values()),
  };
}

async function postEnvelope<T>(
  bridgeBase: string,
  token: string,
  path: string,
  payload: unknown,
): Promise<T> {
  const requestId = `linkedin-scan-${randomUUID()}`;
  const res = await fetch(`${bridgeBase}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-career-ops-token": token,
    },
    body: JSON.stringify({
      protocol: PROTOCOL_VERSION,
      requestId,
      clientTimestamp: new Date().toISOString(),
      payload,
    }),
  });
  const body = await res.json() as BridgeResponse<T>;
  if (!body.ok) {
    const error = (body as Extract<BridgeResponse<T>, { ok: false }>).error;
    throw new Error(`${path} failed: ${error.code} ${error.message}`);
  }
  return body.result;
}

async function getEnvelope<T>(
  bridgeBase: string,
  token: string,
  path: string,
): Promise<T> {
  const res = await fetch(`${bridgeBase}${path}`, {
    headers: { "x-career-ops-token": token },
  });
  const body = await res.json() as BridgeResponse<T>;
  if (!body.ok) {
    const error = (body as Extract<BridgeResponse<T>, { ok: false }>).error;
    throw new Error(`${path} failed: ${error.code} ${error.message}`);
  }
  return body.result;
}

function truncateEnrichedRow(row: EnrichedRow): EnrichedRow {
  return {
    row: {
      ...row.row,
      row: {
        ...row.row.row,
        qualifications: row.row.row.qualifications?.slice(0, 4000) ?? null,
      },
    },
    detail: {
      ...row.detail,
      description: row.detail.description.slice(0, 20_000),
      responsibilities: row.detail.responsibilities.slice(0, 20),
      requiredQualifications: row.detail.requiredQualifications.slice(0, 20),
      skillTags: row.detail.skillTags.slice(0, 30),
      recommendationTags: row.detail.recommendationTags.slice(0, 30),
      taxonomy: row.detail.taxonomy.slice(0, 30),
      applyFlowUrls: row.detail.applyFlowUrls.slice(0, 10),
    },
  };
}

function buildLinkedInReviewCandidates(
  enrichedRows: readonly EnrichedRow[],
  bridgeCandidates: readonly PipelineEntry[],
): PipelineEntry[] {
  const scanConfig = loadNewGradScanConfig(repoRoot);
  const negativeKeywords = loadNegativeKeywords(repoRoot);
  const trackedSet = loadTrackedCompanyRoles(repoRoot);
  const existingKeys = new Set(bridgeCandidates.flatMap(pipelineEntryKeys));
  const reviewCandidates: PipelineEntry[] = [];

  for (const enrichedRow of enrichedRows) {
    if (!isLinkedInEnrichedRow(enrichedRow)) continue;

    const valueScore = scoreEnrichedRowValue(enrichedRow, scanConfig);
    if (valueScore.passed || hasLinkedInReviewBlockingPenalty(valueScore.penalties)) {
      continue;
    }

    const augmentedRow = buildAugmentedRowForReview(enrichedRow);
    const { promoted } = scoreAndFilter(
      [augmentedRow],
      scanConfig,
      negativeKeywords,
      trackedSet,
    );
    const rescored = promoted[0];
    if (!rescored || rescored.score < scanConfig.pipeline_threshold) {
      continue;
    }

    const candidate: PipelineEntry = {
      url: pickPipelineEntryUrl(enrichedRow.detail, enrichedRow.row.row),
      company: enrichedRow.detail.company || enrichedRow.row.row.company,
      role: enrichedRow.detail.title || enrichedRow.row.row.title,
      score: rescored.score,
      source: "linkedin.com",
      valueReasons: [
        "linkedin_review_fallback",
        ...valueScore.reasons,
      ],
    };
    const keys = pipelineEntryKeys(candidate);
    if (keys.some((key) => existingKeys.has(key))) continue;
    for (const key of keys) existingKeys.add(key);
    reviewCandidates.push(candidate);
  }

  return reviewCandidates;
}

function isLinkedInEnrichedRow(row: EnrichedRow): boolean {
  const source = row.row.row.source ?? "";
  return source.includes("linkedin") ||
    row.row.row.detailUrl.includes("linkedin.com/jobs/") ||
    row.detail.originalPostUrl.includes("linkedin.com/jobs/");
}

function hasLinkedInReviewBlockingPenalty(penalties: readonly string[]): boolean {
  return penalties.some((penalty) => [
    "seniority_too_high",
    "no_sponsorship",
    "salary_below_minimum",
    "site_match_below_bar",
  ].includes(penalty));
}

function buildAugmentedRowForReview(enrichedRow: EnrichedRow): NewGradRow {
  return {
    ...enrichedRow.row.row,
    qualifications: [
      enrichedRow.row.row.qualifications ?? "",
      enrichedRow.detail.description,
      enrichedRow.detail.requiredQualifications.join(" "),
    ].join(" "),
    sponsorshipSupport:
      enrichedRow.detail.sponsorshipSupport !== "unknown"
        ? enrichedRow.detail.sponsorshipSupport
        : enrichedRow.row.row.sponsorshipSupport,
    confirmedSponsorshipSupport:
      enrichedRow.detail.confirmedSponsorshipSupport !== "unknown"
        ? enrichedRow.detail.confirmedSponsorshipSupport
        : enrichedRow.row.row.confirmedSponsorshipSupport,
    requiresActiveSecurityClearance:
      enrichedRow.detail.requiresActiveSecurityClearance ||
      enrichedRow.row.row.requiresActiveSecurityClearance,
    confirmedRequiresActiveSecurityClearance:
      enrichedRow.detail.confirmedRequiresActiveSecurityClearance ||
      enrichedRow.row.row.confirmedRequiresActiveSecurityClearance,
  };
}

function dedupeRows(rows: readonly NewGradRow[]): NewGradRow[] {
  const seen = new Set<string>();
  const unique: NewGradRow[] = [];

  for (const row of rows) {
    const key =
      normalizeUrl(row.detailUrl) ??
      normalizeUrl(row.applyUrl) ??
      `${normalizeText(row.company)}|${normalizeText(row.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      ...row,
      position: unique.length + 1,
    });
  }

  return unique;
}

function dedupePipelineEntries(entries: readonly PipelineEntry[]): PipelineEntry[] {
  const seen = new Set<string>();
  const unique: PipelineEntry[] = [];

  for (const entry of entries) {
    const keys = pipelineEntryKeys(entry);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    unique.push(entry);
  }

  return unique;
}

function pipelineEntryKeys(entry: PipelineEntry): string[] {
  const keys: string[] = [];
  const url = normalizeUrl(entry.url);
  if (url) keys.push(`url:${url}`);

  const company = normalizeText(entry.company);
  const role = normalizeText(entry.role);
  if (company || role) keys.push(`company_role:${company}|${role}`);

  if (keys.length === 0) keys.push(`raw:${entry.url}`);
  return keys;
}

function printPromotedRows(rows: readonly ScoredRow[]): void {
  if (rows.length === 0) return;
  console.log("Top promoted rows:");
  for (const [index, row] of rows.slice(0, 10).entries()) {
    console.log(`${index + 1}. ${row.row.company} - ${row.row.title} (${row.score}/${row.maxScore}) ${row.row.detailUrl}`);
  }
}

function printPipelineEntries(entries: readonly PipelineEntry[]): void {
  if (entries.length === 0) return;
  console.log("Pipeline entries:");
  for (const entry of entries) {
    console.log(`- ${entry.company} - ${entry.role} (${entry.score}) ${entry.url}`);
  }
}

function mergeCounts(
  target: Record<string, number> | undefined,
  source: Readonly<Record<string, number>> | undefined,
): void {
  if (!target || !source) return;
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function signalStrings(values: readonly string[], maxItems: number, maxLength: number): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((value) => value.length > maxLength ? value.slice(0, maxLength).trimEnd() : value);
}

function extractYearsExperienceRequired(text: string): number | null {
  const normalized = text.toLowerCase();
  const matches = Array.from(
    normalized.matchAll(/\b(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of\s+experience)?\b/g),
  );
  if (matches.length === 0) return null;

  let maxYears = 0;
  for (const match of matches) {
    maxYears = Math.max(maxYears, Number(match[1]));
  }
  return maxYears > 0 ? maxYears : null;
}

function normalizeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString().toLowerCase();
  } catch {
    return null;
  }
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
