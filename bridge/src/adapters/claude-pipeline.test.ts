import test from "node:test";
import assert from "node:assert/strict";

import { __internal } from "./claude-pipeline.js";

test("extractTerminalJsonObject returns the final Claude JSON payload", () => {
  const stdout = [
    "starting evaluation",
    "",
    "{",
    '  "status": "completed",',
    '  "id": "job-123",',
    '  "report_num": "017",',
    '  "company": "Marble",',
    '  "role": "Founding AI Engineer",',
    '  "score": 4.6,',
    '  "tldr": "Strong fit for agentic product work.",',
    '  "pdf": null,',
    '  "report": "/tmp/reports/017-marble-2026-04-10.md",',
    '  "error": null',
    "}",
  ].join("\n");

  const parsed = __internal.extractTerminalJsonObject(stdout);

  assert.equal(parsed.status, "completed");
  assert.equal(parsed.report_num, "017");
  assert.equal(parsed.score, 4.6);
  assert.equal(parsed.tldr, "Strong fit for agentic product work.");
});

test("parseReportMarkdown extracts report header metadata and summary", () => {
  const markdown = [
    "# Evaluación: Marble AI — Founding AI Engineer",
    "",
    "**Fecha:** 2026-04-10",
    "**Arquetipo:** Agentic / Automation",
    "**Score:** 4.6/5",
    "**URL:** https://jobs.ashbyhq.com/marble.ai/abc",
    "**PDF:** pendiente",
    "",
    "---",
    "",
    "## A) Resumen del Rol",
    "Strong fit for agentic product work in a small team.",
    "",
    "## B) Match con CV",
    "Detalles",
  ].join("\n");

  const parsed = __internal.parseReportMarkdown(markdown);

  assert.equal(parsed.company, "Marble AI");
  assert.equal(parsed.role, "Founding AI Engineer");
  assert.equal(parsed.date, "2026-04-10");
  assert.equal(parsed.archetype, "Agentic / Automation");
  assert.equal(parsed.score, 4.6);
  assert.equal(parsed.url, "https://jobs.ashbyhq.com/marble.ai/abc");
  assert.equal(parsed.tldr, "Strong fit for agentic product work in a small team.");
});
