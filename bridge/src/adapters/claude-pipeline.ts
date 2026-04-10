/**
 * claude-pipeline.ts — real PipelineAdapter that shells out to `claude -p`.
 *
 * MVP scope:
 *   • Single job-page input from the extension.
 *   • Write a real report to reports/.
 *   • Return real score + summary + report path to the popup.
 *   • Write a tracker TSV drop file without touching applications.md.
 *
 * This intentionally keeps the implementation narrow. It reuses the
 * existing batch prompt contract, but the adapter itself owns:
 *   • report-number reservation
 *   • JD tempfile creation
 *   • final JSON extraction
 *   • report header parsing
 *   • tracker TSV synthesis
 */

import type {
  DoctorReport,
  LivenessCheck,
  MergeReport,
  PipelineAdapter,
  PipelineConfig,
  PipelineProgressHandler,
  ReportFile,
} from "../contracts/pipeline.js";
import type {
  EvaluationInput,
  EvaluationResult,
  JobId,
  TrackerRow,
  TrackerStatus,
} from "../contracts/jobs.js";
import type { BridgeError } from "../contracts/envelope.js";

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { bridgeError } from "../runtime/errors.js";
import { JD_MIN_CHARS as JD_MIN_CHARS_VALUE } from "../contracts/jobs.js";

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 100;
const REPORT_NUM_WIDTH = 3;
const MAX_ERROR_TAIL_CHARS = 400;

interface ClaudeTerminalJson {
  status: "completed" | "failed";
  id: string;
  report_num: string | number;
  company?: string;
  role?: string;
  score?: number | null;
  tldr?: string;
  archetype?: string;
  pdf?: string | null;
  report?: string | null;
  error?: string | null;
}

interface ParsedReportMarkdown {
  company: string;
  role: string;
  date: string;
  score: number;
  archetype: string;
  url?: string;
  tldr: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const __internal = {
  extractTerminalJsonObject,
  parseReportMarkdown,
};

export function createClaudePipelineAdapter(
  config: PipelineConfig
): PipelineAdapter {
  return {
    async doctor(): Promise<DoctorReport> {
      const cvOk = existsSync(join(config.repoRoot, "cv.md"));
      const profileOk = existsSync(join(config.repoRoot, "config/profile.yml"));
      const trackerOk = existsSync(
        join(config.repoRoot, "data/applications.md")
      );
      const versionPath = join(config.repoRoot, "VERSION");
      const careerOpsVersion = existsSync(versionPath)
        ? readFileSync(versionPath, "utf-8").trim()
        : "unknown";

      return {
        ok: cvOk && profileOk && trackerOk && Boolean(config.claudeBin),
        repo: {
          rootPath: config.repoRoot,
          careerOpsVersion,
          trackerOk,
          cvOk,
          profileOk,
        },
        claudeCli: {
          ok: Boolean(config.claudeBin),
          ...(config.claudeBin
            ? { version: "present" }
            : { error: "claude CLI not found" }),
        },
        node: { version: process.version },
        playwrightChromium: { ok: true },
      };
    },

    async checkLiveness(url: string): Promise<LivenessCheck> {
      const scriptPath = join(config.repoRoot, "check-liveness.mjs");
      const result = await runCommand(
        config.nodeBin,
        [scriptPath, url],
        config.repoRoot,
        config.livenessTimeoutSec * 1000
      );

      const output = `${result.stdout}\n${result.stderr}`;
      const statusLine = output
        .split(/\r?\n/)
        .find((line) => line.includes(url))
        ?.trim();
      const reasonLine = output
        .split(/\r?\n/)
        .find((line) => /^\s{2,}\S/.test(line) || /^\s+\S/.test(line))
        ?.trim();

      if (result.timedOut) {
        return {
          url,
          status: "uncertain",
          reason: "liveness check timed out",
          exitCode: -1,
        };
      }

      if (statusLine?.includes("✅") || /\bactive\b/i.test(statusLine ?? "")) {
        return {
          url,
          status: "active",
          reason: reasonLine ?? "apply button detected",
          exitCode: result.exitCode ?? 0,
        };
      }

      if (statusLine?.includes("⚠️") || /\buncertain\b/i.test(statusLine ?? "")) {
        return {
          url,
          status: "uncertain",
          reason: reasonLine ?? "content present but no apply button found",
          exitCode: result.exitCode ?? 1,
        };
      }

      return {
        url,
        status: "expired",
        reason: reasonLine ?? "job appears inactive",
        exitCode: result.exitCode ?? 1,
      };
    },

    async runEvaluation(
      jobId: JobId,
      input: EvaluationInput,
      onProgress: PipelineProgressHandler
    ): Promise<EvaluationResult | BridgeError> {
      if (!config.claudeBin) {
        return bridgeError(
          "BRIDGE_NOT_READY",
          "claude CLI not found on PATH"
        );
      }

      const reportDir = join(config.repoRoot, "reports");
      const batchDir = join(config.repoRoot, "batch");
      const logsDir = join(batchDir, "logs");
      const trackerDir = join(batchDir, "tracker-additions");
      mkdirSync(logsDir, { recursive: true });
      mkdirSync(trackerDir, { recursive: true });
      mkdirSync(reportDir, { recursive: true });

      const reportNumber = reserveReportNumber(config.repoRoot);
      const reportNumberText = formatReportNumber(reportNumber);
      const today = todayDate();
      const jdPath = join(tmpdir(), `career-ops-bridge-jd-${jobId}.txt`);
      const promptPath = join(batchDir, `.bridge-prompt-${jobId}.md`);
      const logPath = join(logsDir, `${reportNumberText}-${jobId}.log`);

      try {
        onProgress({
          phase: "extracting_jd",
          at: nowIso(),
          note:
            (input.pageText?.trim().length ?? 0) >= JD_MIN_CHARS_VALUE
              ? "using captured page text"
              : "captured page text is short; Claude may fetch missing details",
        });

        writeFileSync(jdPath, buildJdText(input), "utf-8");
        writeFileSync(
          promptPath,
          buildResolvedPrompt(config.repoRoot, {
            url: input.url,
            jdPath,
            reportNumber: reportNumberText,
            date: today,
            id: jobId,
          }),
          "utf-8"
        );

        onProgress({
          phase: "evaluating",
          at: nowIso(),
          note: `claude -p report ${reportNumberText}`,
        });

        const task = [
          "Procesa esta oferta para el bridge MVP.",
          "Objetivo minimo: generar un report real en reports/ y terminar con JSON valido.",
          `URL: ${input.url}`,
          `JD file: ${jdPath}`,
          `Report number: ${reportNumberText}`,
          `Date: ${today}`,
          `Batch ID: ${jobId}`,
        ].join(" ");

        const args = ["-p"];
        if (config.allowDangerousClaudeFlags) {
          args.push("--dangerously-skip-permissions");
        }
        args.push("--append-system-prompt-file", promptPath, task);

        const command = await runCommand(
          config.claudeBin,
          args,
          config.repoRoot,
          config.evaluationTimeoutSec * 1000
        );

        writeFileSync(
          logPath,
          [command.stdout, command.stderr].filter(Boolean).join("\n\n"),
          "utf-8"
        );

        if (command.timedOut) {
          return bridgeError("TIMEOUT", "evaluation timed out", {
            logPath,
            reportNumber,
          });
        }

        if (command.exitCode !== 0) {
          return bridgeError(
            "EVAL_FAILED",
            extractErrorMessage(command.stderr || command.stdout),
            {
              exitCode: command.exitCode ?? -1,
              logPath,
              reportNumber,
            }
          );
        }

        const terminal = extractTerminalJsonObject(command.stdout);
        if (terminal.status !== "completed") {
          return bridgeError(
            "EVAL_FAILED",
            terminal.error ?? "claude run did not complete successfully",
            { logPath, reportNumber }
          );
        }

        const reportPath = resolveReportPath(
          config.repoRoot,
          reportNumber,
          terminal.report
        );
        if (!reportPath || !existsSync(reportPath)) {
          return bridgeError(
            "EVAL_FAILED",
            `report ${reportNumberText} was not written`,
            { logPath, reportNumber }
          );
        }

        onProgress({
          phase: "writing_report",
          at: nowIso(),
          note: basename(reportPath),
        });

        const reportMarkdown = readFileSync(reportPath, "utf-8");
        const reportMeta = parseReportMarkdown(reportMarkdown);
        const score = coerceScore(terminal.score, reportMeta.score);
        const tldr = terminal.tldr?.trim() || reportMeta.tldr;
        const archetype = terminal.archetype?.trim() || reportMeta.archetype;
        const company = terminal.company?.trim() || reportMeta.company;
        const role = terminal.role?.trim() || reportMeta.role;
        const pdfPath = resolveOptionalArtifactPath(
          config.repoRoot,
          terminal.pdf ?? null
        );

        onProgress({
          phase: "generating_pdf",
          at: nowIso(),
          note: pdfPath ? basename(pdfPath) : "pdf skipped or unavailable",
        });

        const trackerEntryNum = nextTrackerEntryNumber(config.repoRoot);
        const trackerRow = buildTrackerRow({
          num: trackerEntryNum,
          date: reportMeta.date,
          company,
          role,
          score,
          reportPath,
          pdfPath,
          tldr,
        });
        writeTrackerAddition(trackerDir, jobId, trackerRow);

        onProgress({
          phase: "writing_tracker",
          at: nowIso(),
          note: `${jobId}.tsv`,
        });

        return {
          reportNumber,
          reportPath,
          pdfPath,
          company,
          role,
          score,
          archetype,
          tldr,
          trackerRow,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return bridgeError("INTERNAL", message, {
          reportNumber,
          logPath,
        });
      } finally {
        safeRemoveFile(promptPath);
        safeRemoveFile(jdPath);
      }
    },

    async readReport(num: number): Promise<ReportFile | undefined> {
      const reportPath = resolveReportPath(config.repoRoot, num);
      if (!reportPath || !existsSync(reportPath)) return undefined;
      const markdown = readFileSync(reportPath, "utf-8");
      const meta = parseReportMarkdown(markdown);
      return {
        num,
        path: reportPath,
        markdown,
        meta: {
          company: meta.company,
          role: meta.role,
          date: meta.date,
          score: meta.score,
          archetype: meta.archetype,
          ...(meta.url ? { url: meta.url } : {}),
        },
      };
    },

    async readTrackerTail(
      limit: number
    ): Promise<{ rows: readonly TrackerRow[]; totalRows: number }> {
      const trackerPath = join(config.repoRoot, "data/applications.md");
      if (!existsSync(trackerPath)) {
        return { rows: [], totalRows: 0 };
      }

      const rows = parseTrackerRows(readFileSync(trackerPath, "utf-8"));
      const safeLimit = Math.max(0, limit);
      return {
        rows: rows.slice(Math.max(0, rows.length - safeLimit)),
        totalRows: rows.length,
      };
    },

    async mergeTracker(dryRun: boolean): Promise<MergeReport> {
      const args = [join(config.repoRoot, "merge-tracker.mjs")];
      if (dryRun) args.push("--dry-run");
      const result = await runCommand(
        config.nodeBin,
        args,
        config.repoRoot,
        config.evaluationTimeoutSec * 1000
      );

      if (result.timedOut) {
        throw bridgeError("TIMEOUT", "tracker merge timed out");
      }
      if (result.exitCode !== 0) {
        throw bridgeError(
          "TRACKER_MERGE_FAILED",
          extractErrorMessage(result.stderr || result.stdout)
        );
      }

      const summaryMatch = /\+(\d+)\s+added,\s+🔄(\d+)\s+updated,\s+⏭️(\d+)\s+skipped/u.exec(
        result.stdout
      );

      return {
        added: Number(summaryMatch?.[1] ?? 0),
        updated: Number(summaryMatch?.[2] ?? 0),
        skipped: Number(summaryMatch?.[3] ?? 0),
        dryRun,
      };
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function todayDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatReportNumber(n: number): string {
  return String(n).padStart(REPORT_NUM_WIDTH, "0");
}

function buildJdText(input: EvaluationInput): string {
  const pageText = input.pageText?.trim() ?? "";
  const header = [
    `URL: ${input.url}`,
    `Title: ${input.title?.trim() || "(untitled job page)"}`,
    "",
  ].join("\n");

  if (pageText.length >= JD_MIN_CHARS_VALUE) {
    return `${header}${pageText}\n`;
  }

  const fallback = [
    "Captured page text is short.",
    "Use this text if helpful, and fetch the URL only if you need missing details.",
    "",
    pageText || "(no captured page text available)",
    "",
  ].join("\n");

  return `${header}${fallback}`;
}

function buildResolvedPrompt(
  repoRoot: string,
  args: {
    url: string;
    jdPath: string;
    reportNumber: string;
    date: string;
    id: string;
  }
): string {
  const templatePath = join(repoRoot, "batch/batch-prompt.md");
  const template = readFileSync(templatePath, "utf-8");
  const resolved = template
    .replaceAll("{{URL}}", args.url)
    .replaceAll("{{JD_FILE}}", args.jdPath)
    .replaceAll("{{REPORT_NUM}}", args.reportNumber)
    .replaceAll("{{DATE}}", args.date)
    .replaceAll("{{ID}}", args.id);

  const overrides = `

## Bridge MVP Overrides

- Este run es para el adapter real del bridge.
- Exito minimo real:
  1. Guardar el report markdown en \`reports/${args.reportNumber}-{company-slug}-${args.date}.md\`
  2. Terminar imprimiendo un JSON final valido
- El JD en \`${args.jdPath}\` es la fuente primaria. Si es corto, puedes leer la URL para completar huecos.
- Si el PDF falla, NO falles todo el run: continua, deja \`pdf: null\` o \`pendiente\`, y sigue con el report.
- No edites \`data/applications.md\` directamente.
- En el JSON final incluye tambien:
  - \`tldr\`: una frase real y concreta
  - \`archetype\`: el arquetipo detectado
- El JSON final debe ser el ultimo bloque impreso por stdout.
`;

  return `${resolved}\n${overrides}`;
}

function reserveReportNumber(repoRoot: string): number {
  const lockDir = join(repoRoot, "batch/.batch-state.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      const code =
        err instanceof Error && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      if (code !== "EEXIST") {
        throw err;
      }
      if (Date.now() >= deadline) {
        throw bridgeError(
          "REPO_LOCKED",
          "timed out waiting for batch report-number lock"
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }

  try {
    const reportsDir = join(repoRoot, "reports");
    const names = existsSync(reportsDir) ? readdirSync(reportsDir) : [];
    let maxNum = 0;
    for (const name of names) {
      const match = /^(\d+)-/.exec(name);
      if (!match) continue;
      const num = Number(match[1]);
      if (Number.isFinite(num)) {
        maxNum = Math.max(maxNum, num);
      }
    }
    return maxNum + 1;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number
): Promise<CommandResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({
        exitCode: null,
        stdout,
        stderr,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        timedOut: false,
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        stdout,
        stderr,
        timedOut: false,
      });
    });
  });
}

function extractTerminalJsonObject(stdout: string): ClaudeTerminalJson {
  const marker = stdout.lastIndexOf('"status"');
  if (marker === -1) {
    throw new Error("Claude output did not include a terminal JSON block");
  }

  for (
    let start = stdout.lastIndexOf("{", marker);
    start >= 0;
    start = stdout.lastIndexOf("{", start - 1)
  ) {
    const jsonText = sliceBalancedJson(stdout, start);
    if (!jsonText) continue;
    try {
      const parsed = JSON.parse(jsonText) as Partial<ClaudeTerminalJson>;
      if (
        parsed.status === "completed" ||
        parsed.status === "failed"
      ) {
        if (parsed.report_num === undefined) {
          throw new Error("terminal JSON missing report_num");
        }
        if (typeof parsed.id !== "string" || parsed.id.length === 0) {
          throw new Error("terminal JSON missing id");
        }
        return parsed as ClaudeTerminalJson;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Unable to parse terminal JSON from Claude output");
}

function sliceBalancedJson(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return undefined;
}

function parseReportMarkdown(markdown: string): ParsedReportMarkdown {
  const headingMatch = markdown.match(
    /^#\s+Evaluación:\s+(.+?)\s+[—-]\s+(.+)$/m
  );
  if (!headingMatch) {
    throw new Error("report header missing company/role heading");
  }

  const date = readHeader(markdown, "Fecha");
  const archetype = readHeader(markdown, "Arquetipo");
  const scoreRaw = readHeader(markdown, "Score");
  const url = readOptionalHeader(markdown, "URL");
  const scoreMatch = /([\d.]+)\s*\/\s*5/.exec(scoreRaw);
  if (!scoreMatch) {
    throw new Error("report header missing numeric score");
  }

  const tldr =
    extractTldrFromSummaryTable(markdown) ??
    extractSummaryParagraph(markdown) ??
    "Evaluation completed";

  return {
    company: headingMatch[1]!.trim(),
    role: headingMatch[2]!.trim(),
    date: date.trim(),
    score: Number(scoreMatch[1]),
    archetype: archetype.trim(),
    ...(url ? { url: url.trim() } : {}),
    tldr,
  };
}

function readHeader(markdown: string, label: string): string {
  const value = readOptionalHeader(markdown, label);
  if (!value) {
    throw new Error(`report header missing ${label}`);
  }
  return value;
}

function readOptionalHeader(markdown: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(`^\\*\\*${escaped}:\\*\\*\\s+(.+)$`, "m")
  );
  return match?.[1]?.trim();
}

function extractTldrFromSummaryTable(markdown: string): string | undefined {
  const match = markdown.match(/^\|\s*TL;DR\s*\|\s*(.+?)\s*\|$/im);
  return match?.[1]?.trim();
}

function extractSummaryParagraph(markdown: string): string | undefined {
  const sectionMatch = markdown.match(
    /##\s+A\)\s+Resumen del Rol\s*([\s\S]*?)(?:\n##\s+[B-Z]\)|$)/
  );
  const section = sectionMatch?.[1];
  if (!section) return undefined;

  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("|"))
    .filter((line) => !/^[-:]{3,}$/.test(line));

  return lines[0];
}

function resolveReportPath(
  repoRoot: string,
  reportNumber: number,
  hint?: string | null
): string | undefined {
  const reportsDir = join(repoRoot, "reports");
  if (hint) {
    const candidate = resolveArtifactPath(repoRoot, hint);
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  const prefix = `${formatReportNumber(reportNumber)}-`;
  const names = existsSync(reportsDir) ? readdirSync(reportsDir) : [];
  const match = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
    .sort()
    .at(-1);
  return match ? join(reportsDir, match) : undefined;
}

function resolveOptionalArtifactPath(
  repoRoot: string,
  rawPath: string | null
): string | null {
  if (!rawPath) return null;
  if (/^pendiente$/i.test(rawPath.trim())) return null;
  const resolved = resolveArtifactPath(repoRoot, rawPath);
  return resolved && existsSync(resolved) ? resolved : null;
}

function resolveArtifactPath(
  repoRoot: string,
  rawPath: string
): string | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("/")
    ? trimmed
    : resolve(repoRoot, trimmed.replace(/^career-ops\//, ""));
}

function coerceScore(
  candidate: number | null | undefined,
  fallback: number
): number {
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return Number(candidate.toFixed(2));
  }
  return Number(fallback.toFixed(2));
}

function nextTrackerEntryNumber(repoRoot: string): number {
  const trackerPath = join(repoRoot, "data/applications.md");
  if (!existsSync(trackerPath)) return 1;

  let maxNum = 0;
  for (const row of parseTrackerRows(readFileSync(trackerPath, "utf-8"))) {
    maxNum = Math.max(maxNum, row.num);
  }
  return maxNum + 1;
}

function buildTrackerRow(args: {
  num: number;
  date: string;
  company: string;
  role: string;
  score: number;
  reportPath: string;
  pdfPath: string | null;
  tldr: string;
}): TrackerRow {
  const scoreText = `${Number(args.score.toFixed(2))}/5` as TrackerRow["score"];
  const reportFile = basename(args.reportPath);
  return {
    num: args.num,
    date: args.date,
    company: args.company,
    role: args.role,
    status: "Evaluated",
    score: scoreText,
    pdf: args.pdfPath ? "✅" : "❌",
    report: `[${formatReportNumber(extractReportNumberFromPath(reportFile))}](reports/${reportFile})`,
    notes: truncateSingleLine(args.tldr, 180),
  };
}

function extractReportNumberFromPath(name: string): number {
  const match = /^(\d+)-/.exec(name);
  return Number(match?.[1] ?? 0);
}

function writeTrackerAddition(
  trackerDir: string,
  jobId: string,
  row: TrackerRow
): void {
  const tsvPath = join(trackerDir, `${jobId}.tsv`);
  const content = [
    row.num,
    row.date,
    row.company,
    row.role,
    row.status,
    row.score,
    row.pdf,
    row.report,
    row.notes,
  ].join("\t");
  writeFileSync(tsvPath, `${content}\n`, "utf-8");
}

function truncateSingleLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1).trim()}…`;
}

function parseTrackerRows(markdown: string): TrackerRow[] {
  const rows: TrackerRow[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    if (line.includes("---")) continue;
    if (/\|\s*#\s*\|/.test(line)) continue;

    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 10) continue;

    const num = Number(parts[1]);
    if (!Number.isFinite(num) || num <= 0) continue;

    rows.push({
      num,
      date: parts[2] ?? "",
      company: parts[3] ?? "",
      role: parts[4] ?? "",
      score: ((parts[5] ?? "0/5") as TrackerRow["score"]),
      status: normalizeTrackerStatus(parts[6] ?? ""),
      pdf: (parts[7] === "✅" ? "✅" : "❌") as TrackerRow["pdf"],
      report: parts[8] ?? "",
      notes: parts[9] ?? "",
    });
  }
  return rows;
}

function normalizeTrackerStatus(raw: string): TrackerStatus {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "applied":
      return "Applied";
    case "responded":
      return "Responded";
    case "interview":
      return "Interview";
    case "offer":
      return "Offer";
    case "rejected":
      return "Rejected";
    case "discarded":
      return "Discarded";
    case "skip":
      return "SKIP";
    default:
      return "Evaluated";
  }
}

function extractErrorMessage(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "evaluation failed";
  return normalized.slice(0, MAX_ERROR_TAIL_CHARS);
}

function safeRemoveFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort cleanup only
  }
}
