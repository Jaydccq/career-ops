/**
 * cleanup-after-cancel.test.ts — unit tests for the filesystem cleanup
 * that runs after a user cancels an in-flight evaluation.
 *
 * Contract (see claude-pipeline.ts::cleanupAfterCancel):
 *   • Report file: keep iff non-empty AND parseReportMarkdown succeeds.
 *   • Tracker TSV ({jobId}.tsv): always delete if present.
 *   • JD + prompt + terminal ephemeral files: always delete.
 *   • Missing files: no-op, no crash.
 */

import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __internal } from "../claude-pipeline.js";
import type { JobId } from "../../contracts/jobs.js";

const { cleanupAfterCancel } = __internal as unknown as {
  cleanupAfterCancel: (args: {
    repoRoot: string;
    reportNumber: number;
    trackerDir: string;
    jobId: JobId;
    promptPath: string;
    jdPath: string;
    terminalFilePath?: string;
  }) => void;
};

interface Sandbox {
  repoRoot: string;
  reportsDir: string;
  trackerDir: string;
  reportPath: string;
  reportName: string;
  tsvPath: string;
  jdPath: string;
  promptPath: string;
  terminalPath: string;
  jobId: JobId;
  reportNumber: number;
}

function makeSandbox(): Sandbox {
  const repoRoot = mkdtempSync(join(tmpdir(), "career-ops-cancel-"));
  const reportsDir = join(repoRoot, "reports");
  const trackerDir = join(repoRoot, "batch", "tracker-additions");
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(trackerDir, { recursive: true });

  const reportNumber = 42;
  const reportName = "042-fake-co-2026-04-12.md";
  const reportPath = join(reportsDir, reportName);
  const jobId = "job-abc" as JobId;
  const tsvPath = join(trackerDir, `${jobId}.tsv`);
  const jdPath = join(repoRoot, "jd.txt");
  const promptPath = join(repoRoot, "prompt.md");
  const terminalPath = join(repoRoot, "terminal.json");

  return {
    repoRoot,
    reportsDir,
    trackerDir,
    reportPath,
    reportName,
    tsvPath,
    jdPath,
    promptPath,
    terminalPath,
    jobId,
    reportNumber,
  };
}

function cleanSandbox(sb: Sandbox): void {
  rmSync(sb.repoRoot, { recursive: true, force: true });
}

function parseableReport(): string {
  return [
    "# Evaluación: Fake Co — Staff Engineer",
    "",
    "**Fecha:** 2026-04-12",
    "**Arquetipo:** Backend",
    "**Score:** 4.0/5",
    "**URL:** https://example.com/fake",
    "**PDF:** pendiente",
    "",
    "## A) Resumen del Rol",
    "",
    "Great opportunity.",
    "",
  ].join("\n");
}

describe("cleanupAfterCancel", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox();
  });

  afterEach(() => {
    cleanSandbox(sb);
  });

  test("deletes an empty report file", () => {
    writeFileSync(sb.reportPath, "", "utf-8");
    writeFileSync(sb.jdPath, "jd contents", "utf-8");
    writeFileSync(sb.promptPath, "prompt contents", "utf-8");

    cleanupAfterCancel({
      repoRoot: sb.repoRoot,
      reportNumber: sb.reportNumber,
      trackerDir: sb.trackerDir,
      jobId: sb.jobId,
      promptPath: sb.promptPath,
      jdPath: sb.jdPath,
    });

    expect(existsSync(sb.reportPath)).toBe(false);
  });

  test("deletes a partial (unparseable) report file", () => {
    writeFileSync(
      sb.reportPath,
      "# half a heading and nothing else\n",
      "utf-8",
    );

    cleanupAfterCancel({
      repoRoot: sb.repoRoot,
      reportNumber: sb.reportNumber,
      trackerDir: sb.trackerDir,
      jobId: sb.jobId,
      promptPath: sb.promptPath,
      jdPath: sb.jdPath,
    });

    expect(existsSync(sb.reportPath)).toBe(false);
  });

  test("keeps a parseable report (audit trail)", () => {
    const content = parseableReport();
    writeFileSync(sb.reportPath, content, "utf-8");

    cleanupAfterCancel({
      repoRoot: sb.repoRoot,
      reportNumber: sb.reportNumber,
      trackerDir: sb.trackerDir,
      jobId: sb.jobId,
      promptPath: sb.promptPath,
      jdPath: sb.jdPath,
    });

    expect(existsSync(sb.reportPath)).toBe(true);
    expect(readFileSync(sb.reportPath, "utf-8")).toBe(content);
  });

  test("deletes a tracker TSV keyed by jobId", () => {
    writeFileSync(sb.tsvPath, "42\t2026-04-12\tFake\tRole\n", "utf-8");

    cleanupAfterCancel({
      repoRoot: sb.repoRoot,
      reportNumber: sb.reportNumber,
      trackerDir: sb.trackerDir,
      jobId: sb.jobId,
      promptPath: sb.promptPath,
      jdPath: sb.jdPath,
    });

    expect(existsSync(sb.tsvPath)).toBe(false);
  });

  test("deletes JD, prompt, and terminal ephemeral files", () => {
    writeFileSync(sb.jdPath, "jd", "utf-8");
    writeFileSync(sb.promptPath, "prompt", "utf-8");
    writeFileSync(sb.terminalPath, "{}", "utf-8");

    cleanupAfterCancel({
      repoRoot: sb.repoRoot,
      reportNumber: sb.reportNumber,
      trackerDir: sb.trackerDir,
      jobId: sb.jobId,
      promptPath: sb.promptPath,
      jdPath: sb.jdPath,
      terminalFilePath: sb.terminalPath,
    });

    expect(existsSync(sb.jdPath)).toBe(false);
    expect(existsSync(sb.promptPath)).toBe(false);
    expect(existsSync(sb.terminalPath)).toBe(false);
  });

  test("no crash when all files are missing", () => {
    // Deliberately do not create anything. Sandbox only has empty dirs.
    expect(() =>
      cleanupAfterCancel({
        repoRoot: sb.repoRoot,
        reportNumber: sb.reportNumber,
        trackerDir: sb.trackerDir,
        jobId: sb.jobId,
        promptPath: sb.promptPath,
        jdPath: sb.jdPath,
        terminalFilePath: sb.terminalPath,
      }),
    ).not.toThrow();
  });

  test("parseable report is kept even when ephemeral files are also present", () => {
    writeFileSync(sb.reportPath, parseableReport(), "utf-8");
    writeFileSync(sb.tsvPath, "42\tx\n", "utf-8");
    writeFileSync(sb.jdPath, "jd", "utf-8");
    writeFileSync(sb.promptPath, "prompt", "utf-8");

    cleanupAfterCancel({
      repoRoot: sb.repoRoot,
      reportNumber: sb.reportNumber,
      trackerDir: sb.trackerDir,
      jobId: sb.jobId,
      promptPath: sb.promptPath,
      jdPath: sb.jdPath,
    });

    expect(existsSync(sb.reportPath)).toBe(true);
    // Even with a surviving report, the pending TSV is cleared so the
    // merge script doesn't pick up a half-finished row.
    expect(existsSync(sb.tsvPath)).toBe(false);
    expect(existsSync(sb.jdPath)).toBe(false);
    expect(existsSync(sb.promptPath)).toBe(false);
  });
});
