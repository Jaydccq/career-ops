#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCmd = process.execPath;

const host = process.env.CAREER_OPS_BRIDGE_HOST ?? "127.0.0.1";
const port = process.env.CAREER_OPS_BRIDGE_PORT ?? "47319";
const bridgeBase = `http://${host}:${port}`;

const timeZone = process.env.CAREER_OPS_SCAN_TIMEZONE ?? "America/New_York";
const ignoreWindow = process.env.CAREER_OPS_SCAN_IGNORE_WINDOW === "1";
const dryRun = process.env.CAREER_OPS_SCAN_DRY_RUN === "1";
const startBridge = process.env.CAREER_OPS_SCAN_START_BRIDGE === "1";
const requireBridge = process.env.CAREER_OPS_SCAN_REQUIRE_BRIDGE === "1";

const automationDir = join(repoRoot, "data", "automation");
const lockPath = join(automationDir, "hourly-scan.lock");
const lockTtlMs = Number(process.env.CAREER_OPS_SCAN_LOCK_TTL_MS ?? 75 * 60 * 1000);
const stepTimeoutMs = Number(process.env.CAREER_OPS_SCAN_STEP_TIMEOUT_MS ?? 45 * 60 * 1000);
const bridgeWaitMs = Number(process.env.CAREER_OPS_SCAN_BRIDGE_WAIT_MS ?? 15_000);

const sources = (process.env.CAREER_OPS_SCAN_SOURCES ?? "scan,newgrad,builtin,linkedin,indeed")
  .split(",")
  .map((source) => source.trim())
  .filter(Boolean);

const evalMode = process.env.CAREER_OPS_SCAN_EVAL_MODE ?? "newgrad_quick";
const defaultEvalLimit = process.env.CAREER_OPS_SCAN_EVALUATE_LIMIT ?? "3";
const defaultEnrichLimit = process.env.CAREER_OPS_SCAN_ENRICH_LIMIT ?? "10";
const waitTimeout = process.env.CAREER_OPS_SCAN_EVAL_WAIT_MS ?? "900000";

const indeedQuery = process.env.CAREER_OPS_INDEED_QUERY ?? "software engineer, AI engineer";
const indeedLocation = process.env.CAREER_OPS_INDEED_LOCATION ?? "";
const linkedinPostedWithin = process.env.CAREER_OPS_LINKEDIN_POSTED_WITHIN ?? "r4000";

let bridgeChild = null;
let releaseLock = null;

function localParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value;
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;

  return {
    weekday: get("weekday"),
    hour,
    minute: Number(get("minute")),
  };
}

function insideScheduleWindow(date) {
  const parts = localParts(date);
  const weekdayOk = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(parts.weekday);
  return weekdayOk && parts.hour >= 8 && parts.hour <= 22;
}

async function acquireLock() {
  await mkdir(automationDir, { recursive: true });

  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    return async () => {
      await handle.close().catch(() => {});
      await rm(lockPath, { force: true }).catch(() => {});
    };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;

    const lockStat = await stat(lockPath).catch(() => null);
    if (lockStat && Date.now() - lockStat.mtimeMs > lockTtlMs) {
      await rm(lockPath, { force: true });
      return acquireLock();
    }

    console.log("A previous hourly scan is still running. Exiting without overlap.");
    process.exit(0);
  }
}

async function readBridgeToken() {
  const tokenPath = join(repoRoot, "apps", "server", ".bridge-token");
  if (!existsSync(tokenPath)) return null;
  return (await readFile(tokenPath, "utf8")).trim();
}

async function bridgeHealth() {
  const token = await readBridgeToken();
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${bridgeBase}/v1/health`, {
      headers: { "x-career-ops-token": token },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const body = await response.json();
    return body.result ?? body.payload ?? body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isCodexRealBridge(health) {
  return health?.execution?.mode === "real" && health?.execution?.realExecutor === "codex";
}

async function prepareBridge() {
  if (dryRun) {
    return {
      writesEnabled: false,
      status: "dry_run",
      detail: "Dry run requested; bridge startup and write/evaluation paths are disabled.",
    };
  }

  const existing = await waitForBridge();
  if (isCodexRealBridge(existing)) {
    console.log("Using existing career-ops bridge in real/codex mode.");
    return {
      writesEnabled: true,
      status: "existing_real_codex",
      detail: `Using existing bridge at ${bridgeBase}.`,
    };
  }

  if (existing) {
    const message = `Bridge at ${bridgeBase} is running but is not real/codex. Stop it and run "npm run server".`;
    if (requireBridge) throw new Error(message);
    console.warn(message);
    console.warn("Continuing in read-only preview mode.");
    return {
      writesEnabled: false,
      status: "wrong_bridge_mode",
      detail: message,
    };
  }

  if (!startBridge) {
    const message = `No real/codex bridge is reachable at ${bridgeBase}. Continuing in read-only preview mode.`;
    if (requireBridge) {
      throw new Error(`${message} Recovery: start the bridge outside the automation sandbox with "npm run server".`);
    }
    console.warn(message);
    console.warn('For write/evaluation runs, start the bridge outside the automation sandbox with "npm run server".');
    return {
      writesEnabled: false,
      status: "bridge_unavailable_preview",
      detail: `${message} Recovery: npm run server`,
    };
  }

  console.log("Starting career-ops bridge in real/codex mode.");
  bridgeChild = spawn(nodeCmd, ["scripts/bridge-start.mjs", "real-codex"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAREER_OPS_BRIDGE_HOST: host,
      CAREER_OPS_BRIDGE_PORT: port,
      CAREER_OPS_BRIDGE_MODE: "real",
      CAREER_OPS_REAL_EXECUTOR: "codex",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  bridgeChild.stdout.on("data", (chunk) => process.stdout.write(`[bridge] ${chunk}`));
  bridgeChild.stderr.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`));

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(500);
    const health = await bridgeHealth();
    if (isCodexRealBridge(health)) {
      console.log("Bridge is ready.");
      return {
        writesEnabled: true,
        status: "started_real_codex",
        detail: `Started bridge at ${bridgeBase}.`,
      };
    }
  }

  const message = 'Bridge did not become healthy in real/codex mode. Recovery: run "npm run server".';
  if (requireBridge) throw new Error(message);
  console.warn(message);
  console.warn("Continuing in read-only preview mode.");
  return {
    writesEnabled: false,
    status: "bridge_start_failed_preview",
    detail: message,
  };
}

async function waitForBridge() {
  const deadline = Date.now() + Math.max(0, bridgeWaitMs);
  let lastHealth = await bridgeHealth();
  if (isCodexRealBridge(lastHealth) || bridgeWaitMs <= 0) return lastHealth;

  while (Date.now() < deadline) {
    await sleep(500);
    lastHealth = await bridgeHealth();
    if (isCodexRealBridge(lastHealth)) return lastHealth;
  }

  return lastHealth;
}

function stopBridgeIfStarted() {
  if (!bridgeChild || bridgeChild.killed) return;

  try {
    if (process.platform === "win32") {
      bridgeChild.kill("SIGTERM");
    } else {
      process.kill(-bridgeChild.pid, "SIGTERM");
    }
  } catch {
    bridgeChild.kill("SIGTERM");
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function linkedinAutomationUrl() {
  const explicitUrl = process.env.CAREER_OPS_LINKEDIN_URL;
  const baseUrl = explicitUrl?.trim() || (await readLinkedinProfileUrl());
  if (!baseUrl) return null;

  const url = new URL(baseUrl);
  url.searchParams.set("f_TPR", linkedinPostedWithin);
  return url.toString();
}

async function indeedAutomationUrl() {
  const explicitUrl = process.env.CAREER_OPS_INDEED_URL;
  const baseUrl = explicitUrl?.trim() || (await readIndeedProfileUrl());
  return baseUrl || null;
}

async function readLinkedinProfileUrl() {
  const profilePath = join(repoRoot, "config", "profile.yml");
  if (!existsSync(profilePath)) return null;

  const parsed = yaml.load(await readFile(profilePath, "utf8"));
  if (!parsed || typeof parsed !== "object") return null;

  const value = parsed.linkedin_scan?.search_url;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readIndeedProfileUrl() {
  const profilePath = join(repoRoot, "config", "profile.yml");
  if (!existsSync(profilePath)) return null;

  const parsed = yaml.load(await readFile(profilePath, "utf8"));
  if (!parsed || typeof parsed !== "object") return null;

  const value = parsed.indeed_scan?.search_url;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function commandForSource(source, writesEnabled) {
  const preview = dryRun || !writesEnabled;
  const indeedLocationArgs = indeedLocation.trim() ? ["--location", indeedLocation] : [];
  const sharedEvalArgs = [
    "--evaluate-limit",
    defaultEvalLimit,
    "--evaluation-mode",
    evalMode,
    "--evaluation-wait-timeout-ms",
    waitTimeout,
  ];

  if (source === "scan") {
    return preview
      ? ["run", "scan", "--", "--dry-run"]
      : [
          "run",
          "scan",
          "--",
          "--evaluate",
          "--evaluate-limit",
          defaultEvalLimit,
          "--evaluation-mode",
          evalMode,
          "--evaluation-wait-timeout-ms",
          waitTimeout,
        ];
  }

  if (source === "newgrad") {
    return preview
      ? ["run", "newgrad-scan", "--", "--score-only", "--limit", "50"]
      : ["run", "newgrad-scan", "--", "--enrich-limit", defaultEnrichLimit, ...sharedEvalArgs];
  }

  if (source === "builtin") {
    return preview
      ? ["run", "builtin-scan", "--", "--score-only", "--pages", "1", "--limit", "50"]
      : ["run", "builtin-scan", "--", "--pages", "1", "--limit", "50", "--enrich-limit", defaultEnrichLimit, ...sharedEvalArgs];
  }

  if (source === "linkedin") {
    const url = await linkedinAutomationUrl();
    const urlArgs = url ? ["--url", url] : [];
    return preview
      ? ["run", "linkedin-scan", "--", ...urlArgs, "--score-only", "--pages", "3", "--limit", "75"]
      : [
          "run",
          "linkedin-scan",
          "--",
          ...urlArgs,
          "--pages",
          "3",
          "--limit",
          "75",
          "--enrich-limit",
          defaultEnrichLimit,
          ...sharedEvalArgs,
        ];
  }

  if (source === "indeed") {
    const url = await indeedAutomationUrl();
    const searchArgs = url ? ["--url", url] : ["--query", indeedQuery, ...indeedLocationArgs];
    return preview
      ? [
          "run",
          "indeed-scan",
          "--",
          ...searchArgs,
          "--score-only",
          "--pages",
          "1",
          "--limit",
          "50",
        ]
      : [
          "run",
          "indeed-scan",
          "--",
          ...searchArgs,
          "--pages",
          "1",
          "--limit",
          "50",
          "--enrich-limit",
          defaultEnrichLimit,
          ...sharedEvalArgs,
        ];
  }

  return null;
}

async function runCommand(label, args) {
  const startedAt = Date.now();
  console.log("");
  console.log(`Starting source: ${label}`);
  console.log(`${npmCmd} ${args.join(" ")}`);

  return new Promise((resolveRun) => {
    const child = spawn(npmCmd, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let outputTail = "";
    const append = (chunk, stream) => {
      const text = chunk.toString();
      outputTail = (outputTail + text).slice(-12_000);
      stream.write(text);
    };

    child.stdout.on("data", (chunk) => append(chunk, process.stdout));
    child.stderr.on("data", (chunk) => append(chunk, process.stderr));

    const timer = setTimeout(() => {
      outputTail += `\nTimed out after ${stepTimeoutMs}ms\n`;
      child.kill("SIGTERM");
    }, stepTimeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        label,
        ok: code === 0,
        code,
        signal,
        durationMs: Date.now() - startedAt,
        outputTail,
      });
    });
  });
}

function completedEvaluations(result) {
  const matches = [...result.outputTail.matchAll(/(?:Direct|Scan) evaluation result: completed=(\d+)/g)];
  return matches.reduce((total, match) => total + Number(match[1]), 0);
}

function recoveryCommand(label, output) {
  const lower = output.toLowerCase();
  if (lower.includes("chrome not connected") || lower.includes("cdp websocket closed")) {
    return "bb-browser daemon shutdown && bb-browser tab list";
  }
  if (lower.includes("bb-browser is not available") || lower.includes("spawn bb-browser enoent")) {
    return "add /Users/hongxichen/.npm-global/bin to the host scheduler PATH";
  }
  if (lower.includes("linkedin") && (lower.includes("login") || lower.includes("checkpoint"))) {
    return "bb-browser open https://www.linkedin.com/login";
  }
  if (lower.includes("indeed") && (lower.includes("verification") || lower.includes("security check") || lower.includes("login"))) {
    return "bb-browser open https://www.indeed.com";
  }
  if (lower.includes("jobright") && lower.includes("login")) {
    return "npm run newgrad-scan:login";
  }
  if (lower.includes("bridge") && (lower.includes("not reachable") || lower.includes("not real/codex"))) {
    return "npm run server";
  }
  if (label === "linkedin" && lower.includes("no rows extracted")) {
    return "bb-browser open https://www.linkedin.com/login";
  }
  if (label === "indeed" && lower.includes("no rows extracted")) {
    return "bb-browser open https://www.indeed.com";
  }
  return "";
}

function blockedReason(output) {
  const lower = output.toLowerCase();
  if (lower.includes("chrome not connected") || lower.includes("cdp websocket closed")) return "browser";
  if (lower.includes("bb-browser is not available") || lower.includes("spawn bb-browser enoent")) return "browser";
  if (lower.includes("login")) return "login";
  if (lower.includes("checkpoint")) return "checkpoint";
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (lower.includes("verification") || lower.includes("security check")) return "verification";
  if (
    lower.includes("failed to parse") ||
    lower.includes("parse error") ||
    lower.includes("parsing failed") ||
    lower.includes("did not contain a jobs array")
  ) return "parsing";
  if (lower.includes("timed out")) return "timeout";
  return "";
}

function highFitLines(results) {
  const lines = [];
  for (const result of results) {
    for (const match of result.outputTail.matchAll(/- (.+?) - (.+?): ([4-5](?:\.\d+)?)\/5 report=(\S+)/g)) {
      lines.push(`- ${match[1]} - ${match[2]} (${match[3]}/5, ${match[4]})`);
    }
    for (const match of result.outputTail.matchAll(/- (.+?) \| (.+?): ([4-5](?:\.\d+)?)\/5 report=(\S+)/g)) {
      lines.push(`- ${match[1]} - ${match[2]} (${match[3]}/5, ${match[4]})`);
    }
    for (const match of result.outputTail.matchAll(/^\s*\+ (.+?) \| (.+?) \| (.+)$/gm)) {
      if (lines.length >= 12) break;
      lines.push(`- ${match[1]} - ${match[2]} (${match[3]})`);
    }
  }
  return [...new Set(lines)].slice(0, 12);
}

async function writeSummary(results, bridgeState) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summaryPath = join(automationDir, `hourly-scan-${stamp}.md`);
  const totalCompleted = results.reduce((total, result) => total + completedEvaluations(result), 0);
  const blockers = results
    .filter((result) => !result.ok)
    .map((result) => ({
      label: result.label,
      reason: blockedReason(result.outputTail),
      recovery: recoveryCommand(result.label, result.outputTail),
    }))
    .filter((item) => item.reason || item.recovery);

  const lines = [
    "# Career-Ops hourly scan",
    "",
    `Started at: ${new Date().toISOString()}`,
    `Timezone guard: ${timeZone}`,
    `Dry run: ${dryRun}`,
    `Bridge status: ${bridgeState.status}`,
    `Writes/evaluations enabled: ${bridgeState.writesEnabled}`,
    `Bridge detail: ${bridgeState.detail}`,
    `Sources requested: ${sources.join(", ")}`,
    `Evaluations completed: ${totalCompleted}`,
    "",
    "| Source | Status | Exit | Duration seconds | Completed evaluations |",
    "|---|---:|---:|---:|---:|",
    ...results.map((result) => {
      const status = result.ok ? "ok" : "failed";
      const seconds = Math.round(result.durationMs / 1000);
      return `| ${result.label} | ${status} | ${result.code ?? result.signal ?? ""} | ${seconds} | ${completedEvaluations(result)} |`;
    }),
    "",
    "## Blockers and recovery",
    "",
    [
      ...(bridgeState.writesEnabled ? [] : [`- bridge: ${bridgeState.status}; recovery: \`npm run server\``]),
      ...(blockers.length === 0
        ? ["No login, checkpoint, rate-limit, verification, parsing, or timeout blocker detected from output tails."]
        : blockers.map((item) => `- ${item.label}: ${item.reason || "manual_recovery"}${item.recovery ? `; recovery: \`${item.recovery}\`` : ""}`)),
    ].join("\n"),
    "",
    "## Newest high-fit roles worth reviewing",
    "",
    ...(highFitLines(results).length > 0 ? highFitLines(results) : ["No 4.0+ completed evaluations or new-offer lines detected in captured output."]),
    "",
    "## Output tails",
    "",
    ...results.flatMap((result) => [
      `### ${result.label}`,
      "",
      "```text",
      result.outputTail.trim(),
      "```",
      "",
    ]),
  ];

  await writeFile(summaryPath, lines.join("\n"), "utf8");
  return summaryPath;
}

async function main() {
  if (!ignoreWindow && !insideScheduleWindow(new Date())) {
    console.log(`Outside schedule window for ${timeZone}. Exiting.`);
    return;
  }

  releaseLock = await acquireLock();
  const results = [];
  let bridgeState = {
    writesEnabled: false,
    status: "not_checked",
    detail: "Bridge was not checked.",
  };

  try {
    bridgeState = await prepareBridge();

    for (const source of sources) {
      const args = await commandForSource(source, bridgeState.writesEnabled);
      if (!args) {
        results.push({
          label: source,
          ok: false,
          code: null,
          signal: null,
          durationMs: 0,
          outputTail: `Unknown source: ${source}`,
        });
        continue;
      }

      results.push(await runCommand(source, args));
    }

    if (bridgeState.writesEnabled) {
      const postSteps = [
        ["merge", ["run", "merge"]],
        ["normalize", ["run", "normalize"]],
        ["dedup", ["run", "dedup"]],
        ["verify", ["run", "verify"]],
        ["dashboard:build", ["run", "dashboard:build"]],
      ];

      for (const [label, args] of postSteps) {
        results.push(await runCommand(label, args));
      }
    }

    const summaryPath = await writeSummary(results, bridgeState);
    console.log("");
    console.log(`Hourly scan summary: ${summaryPath}`);

    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    stopBridgeIfStarted();
    if (releaseLock) await releaseLock();
  }
}

process.on("SIGINT", () => {
  stopBridgeIfStarted();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopBridgeIfStarted();
  process.exit(143);
});

main().catch(async (error) => {
  console.error(error);
  stopBridgeIfStarted();
  if (releaseLock) await releaseLock();
  process.exit(1);
});
