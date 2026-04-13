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
    expect(PHASE_LABEL.assembling).toBe("Compiling findings");
  });

  it("keeps deprecated 'evaluating' entry as a human-readable fallback", () => {
    const label = PHASE_LABEL.evaluating;
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toBe("evaluating");  // must not render as the raw key
  });

  it("keeps 'evaluating' out of the happy-path timeline", () => {
    expect(PHASE_ORDER).not.toContain("evaluating");
  });
});
