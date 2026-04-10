/**
 * newgrad-scorer.ts — Deterministic scoring engine for newgrad-jobs.com rows.
 *
 * Pure functions, no I/O. Scores rows along three dimensions:
 *   1. Role match    — does the title contain a target role keyword?
 *   2. Skill keywords — how many skill terms appear in qualifications?
 *   3. Freshness      — how recently was the listing posted?
 *
 * All scoring is config-driven via NewGradScanConfig from the contracts.
 */

import type {
  FilteredRow,
  NewGradRow,
  NewGradScanConfig,
  ScoreBreakdown,
  ScoredRow,
} from "../contracts/newgrad.js";

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Weight awarded for a matching role keyword in the title. */
const ROLE_MATCH_WEIGHT = 1;

/* -------------------------------------------------------------------------- */
/*  Parsing helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Unit-to-minutes multipliers for time-ago parsing.
 * Supports both long-form ("hours") and short-form ("h") units.
 */
const UNIT_TO_MINUTES: Record<string, number> = {
  minute: 1,
  minutes: 1,
  m: 1,
  hour: 60,
  hours: 60,
  h: 60,
  day: 1440,
  days: 1440,
  d: 1440,
  week: 10080,
  weeks: 10080,
  w: 10080,
  month: 43200,
  months: 43200,
};

/**
 * Parse relative time strings like "2 hours ago", "3d ago", "30 minutes ago"
 * into the number of minutes since posted.
 *
 * Supports long-form ("2 hours ago") and short-form ("2h ago") variants
 * for minute, hour, day, week, and month units.
 *
 * @returns Minutes since posted, or `Infinity` if the string is unparseable.
 */
export function parsePostedAgo(text: string): number {
  // Long form: "2 hours ago", "30 minutes ago"
  const longMatch = /^(\d+)\s+([a-z]+)\s+ago$/i.exec(text.trim());
  if (longMatch) {
    const value = Number(longMatch[1]);
    const unit = longMatch[2]!.toLowerCase();
    const multiplier = UNIT_TO_MINUTES[unit];
    if (multiplier !== undefined) {
      return value * multiplier;
    }
  }

  // Short form: "2h ago", "3d ago"
  const shortMatch = /^(\d+)([a-z])\s+ago$/i.exec(text.trim());
  if (shortMatch) {
    const value = Number(shortMatch[1]);
    const unit = shortMatch[2]!.toLowerCase();
    const multiplier = UNIT_TO_MINUTES[unit];
    if (multiplier !== undefined) {
      return value * multiplier;
    }
  }

  return Infinity;
}

/* -------------------------------------------------------------------------- */
/*  Freshness scoring                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Convert minutes-since-posted into a freshness score using linear decay.
 *
 * Returns `max_points` for brand-new posts, decaying linearly to 0 at
 * `max_days` days old. Posts older than `max_days` (or with Infinity age)
 * score 0.
 *
 * @param minutesAgo  — Minutes since the listing was posted.
 * @param config      — Freshness config with `max_points` and `max_days`.
 * @returns Freshness score in [0, max_points].
 */
export function parseFreshness(
  minutesAgo: number,
  config: NewGradScanConfig["freshness"],
): number {
  if (!isFinite(minutesAgo) || minutesAgo < 0) return 0;

  const maxMinutes = config.max_days * 24 * 60;
  if (minutesAgo >= maxMinutes) return 0;

  // Linear decay: full points at 0 minutes, 0 points at maxMinutes
  const ratio = 1 - minutesAgo / maxMinutes;
  return Math.round(ratio * config.max_points * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/*  Row scoring                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Score a single listing row across three dimensions.
 *
 * **Role match (0 or ROLE_MATCH_WEIGHT):**
 *   If the title contains any keyword from `config.role_keywords`
 *   (case-insensitive), the row earns ROLE_MATCH_WEIGHT points.
 *
 * **Skill keywords (0 to skill_keywords.length):**
 *   Count of unique `config.skill_keywords` terms found in the
 *   qualifications text (case-insensitive). Each match = 1 point,
 *   capped at the total number of skill keywords.
 *
 * **Freshness (0 to config.freshness.max_points):**
 *   Linear decay from max_points (brand new) to 0 (at max_days).
 *
 * @returns ScoredRow with total score, maxScore, and breakdown.
 */
export function scoreRow(row: NewGradRow, config: NewGradScanConfig): ScoredRow {
  const titleLower = row.title.toLowerCase();
  const qualsLower = (row.qualifications ?? "").toLowerCase();

  // --- Role match ---
  const roleMatched = config.role_keywords.some((kw) =>
    titleLower.includes(kw.toLowerCase()),
  );
  const roleScore = roleMatched ? ROLE_MATCH_WEIGHT : 0;

  // --- Skill keywords ---
  const matchedSkills: string[] = [];
  for (const term of config.skill_keywords) {
    if (qualsLower.includes(term.toLowerCase())) {
      matchedSkills.push(term.toLowerCase());
    }
  }
  const skillScore = matchedSkills.length;

  // --- Freshness ---
  const minutesAgo = parsePostedAgo(row.postedAgo);
  const freshnessScore = parseFreshness(minutesAgo, config.freshness);

  // --- Totals ---
  const score = roleScore + skillScore + freshnessScore;
  const maxScore =
    ROLE_MATCH_WEIGHT + config.skill_keywords.length + config.freshness.max_points;

  const breakdown: ScoreBreakdown = {
    roleMatch: roleScore,
    skillHits: matchedSkills.length,
    skillKeywordsMatched: matchedSkills,
    freshness: freshnessScore,
  };

  return { row, score, maxScore, breakdown };
}

/* -------------------------------------------------------------------------- */
/*  Batch scoring + filtering                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Score a batch of rows and separate them into promoted and filtered lists.
 *
 * **Hard filters** (checked in order, first match wins):
 *   1. `negative_title` — title contains any negative keyword (case-insensitive)
 *   2. `already_tracked` — `company|title` (lowercased) exists in trackedCompanyRoles
 *
 * **Soft filter:**
 *   3. `below_threshold` — score < min_score OR score/maxScore < min_ratio
 *
 * Promoted rows are sorted by score descending (highest first).
 *
 * @param rows                — Raw listing rows to score.
 * @param config              — Scoring configuration.
 * @param negativeKeywords    — Title keywords that trigger hard exclusion.
 * @param trackedCompanyRoles — Set of "company|role" strings already tracked.
 * @returns `{ promoted, filtered }` with promoted sorted by score desc.
 */
export function scoreAndFilter(
  rows: readonly NewGradRow[],
  config: NewGradScanConfig,
  negativeKeywords: readonly string[],
  trackedCompanyRoles: ReadonlySet<string>,
): { promoted: ScoredRow[]; filtered: FilteredRow[] } {
  const promoted: ScoredRow[] = [];
  const filtered: FilteredRow[] = [];

  const negativeLower = negativeKeywords.map((kw) => kw.toLowerCase());

  for (const row of rows) {
    const titleLower = row.title.toLowerCase();

    // Hard filter 1: negative title keywords
    const matchedNegative = negativeLower.find((kw) => titleLower.includes(kw));
    if (matchedNegative !== undefined) {
      filtered.push({
        row,
        reason: "negative_title",
        detail: `Title contains negative keyword: "${matchedNegative}"`,
      });
      continue;
    }

    // Hard filter 2: already tracked
    const trackingKey = `${row.company.toLowerCase()}|${titleLower}`;
    if (trackedCompanyRoles.has(trackingKey)) {
      filtered.push({
        row,
        reason: "already_tracked",
        detail: `Already tracked: ${row.company} | ${row.title}`,
      });
      continue;
    }

    // Score the row
    const scored = scoreRow(row, config);

    // Soft filter: below threshold (absolute or ratio)
    const ratio = scored.maxScore > 0 ? scored.score / scored.maxScore : 0;
    if (scored.score < config.thresholds.min_score || ratio < config.thresholds.min_ratio) {
      filtered.push({
        row,
        reason: "below_threshold",
        detail: `Score ${scored.score.toFixed(2)}/${scored.maxScore} (ratio ${(ratio * 100).toFixed(1)}%) below threshold`,
      });
      continue;
    }

    promoted.push(scored);
  }

  // Sort promoted by score descending
  promoted.sort((a, b) => b.score - a.score);

  return { promoted, filtered };
}
