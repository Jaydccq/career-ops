/**
 * shared/utils.ts — pure utility functions used by both popup and panel.
 *
 * No DOM access, no chrome APIs, no side effects. These are compile-time
 * bundled into each entry point by esbuild — no runtime module sharing.
 */

import type { JobPhase } from "../contracts/bridge-wire.js";

export type BridgePreset = "fake" | "real-claude" | "real-codex" | "sdk";

export function scoreColor(score: number): string {
  if (score >= 4.0) return "#4ecb71";
  if (score >= 2.5) return "#e5b93c";
  return "#ef5f5f";
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export const PHASE_ORDER: readonly JobPhase[] = [
  "queued",
  "extracting_jd",
  "reading_context",
  "reasoning",
  "assembling",
  "writing_report",
  "generating_pdf",
  "writing_tracker",
  "completed",
];

export const PHASE_LABEL: Record<JobPhase, string> = {
  queued: "Queued",
  extracting_jd: "Extracting job description",
  reading_context: "Reading your CV + portfolio",
  reasoning: "Scoring A\u2013F blocks",
  assembling: "Compiling findings",
  writing_report: "Writing report",
  generating_pdf: "PDF step",
  writing_tracker: "Writing tracker row",
  completed: "Completed",
  failed: "Failed",
  // Deprecated: retained for one release so older popups that receive a
  // legacy "evaluating" SSE event from an older bridge don't crash.
  evaluating: "Evaluating",
};

export function presetDisplayName(preset: BridgePreset): string {
  switch (preset) {
    case "fake": return "fake";
    case "real-claude": return "real / claude";
    case "real-codex": return "real / codex";
    case "sdk": return "sdk";
  }
}

export function presetDescription(preset: BridgePreset): string {
  switch (preset) {
    case "fake":
      return "Fast UI smoke mode. No real report or PDF files are written.";
    case "real-claude":
      return "Full checked-in career-ops flow using claude -p as the executor.";
    case "real-codex":
      return "Full checked-in career-ops flow using codex exec as the executor.";
    case "sdk":
      return "Direct Anthropic SDK mode. Report and tracker write, but PDF is currently skipped.";
  }
}

export function presetCommand(preset: BridgePreset): string {
  switch (preset) {
    case "fake":
      return "npm --prefix bridge run start";
    case "real-claude":
      return "CAREER_OPS_BRIDGE_MODE=real npm --prefix bridge run start";
    case "real-codex":
      return "CAREER_OPS_BRIDGE_MODE=real CAREER_OPS_REAL_EXECUTOR=codex npm --prefix bridge run start";
    case "sdk":
      return "CAREER_OPS_BRIDGE_MODE=sdk ANTHROPIC_API_KEY=... npm --prefix bridge run start";
  }
}

export interface HealthResultLike {
  execution?: { mode?: string; realExecutor?: string | null };
}

export function presetFromHealth(health: HealthResultLike): BridgePreset | null {
  if (health?.execution?.mode === "fake") return "fake";
  if (health?.execution?.mode === "sdk") return "sdk";
  if (health?.execution?.mode === "real") {
    return health?.execution?.realExecutor === "codex" ? "real-codex" : "real-claude";
  }
  return null;
}

/**
 * Format elapsed milliseconds as `m:ss`. Used by the running-phase UI so
 * users can see time passing during the slow `reasoning` phase.
 * 0 → "0:00", 65_000 → "1:05", 3_605_000 → "60:05".
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/**
 * Short "typically takes X" hint shown next to the elapsed counter during
 * the phases where the wait is long enough that users wonder if it's
 * stuck. Returns null for fast phases — nothing to hint about.
 */
export function etaHint(phase: JobPhase): string | null {
  if (phase === "reasoning") return "typically ~1-2 min";
  if (phase === "writing_report") return "a few seconds";
  return null;
}
