import { describe, it, expect } from "vitest";
import { PHASE_ORDER, PHASE_LABEL } from "./utils.js";

describe("evaluating sub-phases", () => {
  it("splits evaluating into reading_context, reasoning, assembling", () => {
    expect(PHASE_ORDER).toEqual([
      "queued",
      "extracting_jd",
      "reading_context",
      "reasoning",
      "assembling",
      "writing_report",
      "generating_pdf",
      "writing_tracker",
      "completed",
    ]);
  });

  it("labels each sub-phase with user-facing copy", () => {
    expect(PHASE_LABEL.reading_context).toBe("Reading your CV + portfolio");
    expect(PHASE_LABEL.reasoning).toMatch(/Scoring/);
    expect(PHASE_LABEL.assembling).toBe("Finalizing report");
  });

  it("keeps deprecated 'evaluating' entry so older popups do not crash", () => {
    expect(PHASE_LABEL.evaluating).toBeDefined();
  });
});
