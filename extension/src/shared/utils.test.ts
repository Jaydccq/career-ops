import { describe, it, expect } from "vitest";
import {
  PHASE_ORDER,
  PHASE_LABEL,
  formatElapsed,
  etaHint,
  shouldDisableEvaluate,
  shouldShowCloseHint,
} from "./utils.js";

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

describe("formatElapsed", () => {
  it("formats zero and sub-minute as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatElapsed(59_999)).toBe("0:59");
  });
  it("pads seconds with a leading zero", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
  });
  it("handles times over an hour without a separate hour field", () => {
    expect(formatElapsed(3_605_000)).toBe("60:05");
  });
  it("clamps negatives to zero", () => {
    expect(formatElapsed(-1)).toBe("0:00");
  });
});

describe("shouldDisableEvaluate", () => {
  it("returns false when no job is running", () => {
    expect(shouldDisableEvaluate(null, null, "https://a")).toBe(false);
  });
  it("returns false when the running job is on the same URL", () => {
    expect(shouldDisableEvaluate("reasoning", "https://a", "https://a")).toBe(false);
  });
  it("returns true when a job is intermediate on a different URL", () => {
    expect(shouldDisableEvaluate("reasoning", "https://a", "https://b")).toBe(true);
    expect(shouldDisableEvaluate("queued", "https://a", "https://b")).toBe(true);
  });
  it("returns false when the running job is already terminal", () => {
    expect(shouldDisableEvaluate("completed", "https://a", "https://b")).toBe(false);
    expect(shouldDisableEvaluate("failed", "https://a", "https://b")).toBe(false);
  });
});

describe("shouldShowCloseHint", () => {
  it("only fires during the slow reasoning phase", () => {
    expect(shouldShowCloseHint("reasoning")).toBe(true);
    expect(shouldShowCloseHint("queued")).toBe(false);
    expect(shouldShowCloseHint("assembling")).toBe(false);
    expect(shouldShowCloseHint("completed")).toBe(false);
    expect(shouldShowCloseHint(null)).toBe(false);
  });
});

describe("etaHint", () => {
  it("returns a hint for the slow reasoning phase", () => {
    expect(etaHint("reasoning")).toMatch(/1.2|~/);
  });
  it("returns a short hint for writing_report", () => {
    expect(etaHint("writing_report")).toMatch(/second/i);
  });
  it("returns null for fast phases that don't need a hint", () => {
    expect(etaHint("queued")).toBeNull();
    expect(etaHint("reading_context")).toBeNull();
    expect(etaHint("assembling")).toBeNull();
    expect(etaHint("extracting_jd")).toBeNull();
  });
});
