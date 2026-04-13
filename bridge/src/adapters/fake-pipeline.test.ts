import { expect, test } from "vitest";

import { createFakePipelineAdapter } from "./fake-pipeline.js";
import type {
  PipelineConfig,
  PipelineProgressHandler,
} from "../contracts/pipeline.js";
import type { EvaluationInput, JobPhase } from "../contracts/jobs.js";

function makeConfig(): PipelineConfig {
  return {
    repoRoot: "/tmp/fake-repo",
    claudeBin: "claude",
    nodeBin: process.execPath,
    evaluationTimeoutSec: 60,
    livenessTimeoutSec: 10,
    allowDangerousClaudeFlags: false,
  };
}

test("fake adapter emits reading_context / reasoning / assembling in order between extracting_jd and writing_report", async () => {
  const adapter = createFakePipelineAdapter(makeConfig(), { phaseDelayMs: 0 });

  const emitted: JobPhase[] = [];
  const onProgress: PipelineProgressHandler = (ev) => {
    emitted.push(ev.phase);
  };

  const input: EvaluationInput = {
    url: "https://example.com/jobs/fake",
    title: "Staff Engineer",
  };

  const result = await adapter.runEvaluation("job-fake-1", input, onProgress);

  // The eval ran to success — not an error envelope.
  expect("code" in result).toBe(false);

  // Sanity: we saw the bracketing phases.
  expect(emitted).toContain("extracting_jd");
  expect(emitted).toContain("writing_report");

  const startIdx = emitted.indexOf("extracting_jd");
  const endIdx = emitted.indexOf("writing_report");
  expect(endIdx).toBeGreaterThan(startIdx);

  const evalWindow = emitted.slice(startIdx + 1, endIdx);
  expect(evalWindow).toEqual(["reading_context", "reasoning", "assembling"]);

  // The migration is complete when no more "evaluating" emits slip through
  // on the happy path.
  expect(emitted).not.toContain("evaluating");
});

test("fake adapter returns CANCELLED when signal is aborted before start", async () => {
  const adapter = createFakePipelineAdapter(makeConfig(), { phaseDelayMs: 0 });
  const controller = new AbortController();
  controller.abort();

  const result = await adapter.runEvaluation(
    "job-fake-cancel-pre" as never,
    { url: "https://example.com/jobs/cancel-pre" },
    () => undefined,
    controller.signal,
  );

  expect("code" in result && result.code === "CANCELLED").toBe(true);
});

test("fake adapter returns CANCELLED when signal is aborted mid-run", async () => {
  // A small but non-zero delay gives us time to abort between phases.
  const adapter = createFakePipelineAdapter(makeConfig(), { phaseDelayMs: 5 });
  const controller = new AbortController();

  const emitted: JobPhase[] = [];
  const run = adapter.runEvaluation(
    "job-fake-cancel-mid" as never,
    { url: "https://example.com/jobs/cancel-mid" },
    (ev) => {
      emitted.push(ev.phase);
      // Abort after the first progress event so we exercise the mid-run path.
      if (emitted.length === 1) controller.abort();
    },
    controller.signal,
  );

  const result = await run;
  expect("code" in result && result.code === "CANCELLED").toBe(true);
});

test("fake adapter forced failure now fires during the reasoning sub-phase", async () => {
  const adapter = createFakePipelineAdapter(makeConfig(), {
    phaseDelayMs: 0,
    forceFailure: true,
  });

  const emitted: JobPhase[] = [];
  const onProgress: PipelineProgressHandler = (ev) => {
    emitted.push(ev.phase);
  };

  const result = await adapter.runEvaluation(
    "job-fake-fail",
    { url: "https://example.com/jobs/fake-fail" },
    onProgress
  );

  // Failure came back as an error envelope.
  expect("code" in result && result.code === "EVAL_FAILED").toBe(true);

  // We must have emitted reasoning before the forced failure triggered.
  expect(emitted).toContain("reasoning");
  // But we should NOT have progressed past reasoning to assembling.
  expect(emitted).not.toContain("assembling");
  // And no legacy "evaluating" phase leaked.
  expect(emitted).not.toContain("evaluating");
});
