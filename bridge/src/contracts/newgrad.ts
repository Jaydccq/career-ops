/**
 * newgrad.ts — shared types for the newgrad-jobs.com scanner feature.
 *
 * Defines the data shapes flowing through the newgrad-scan pipeline:
 *   1. Content script extracts listing rows    -> NewGradRow[]
 *   2. Bridge scores + filters locally         -> ScoredRow[] + FilteredRow[]
 *   3. Bridge enriches from detail pages        -> EnrichedRow[]
 *   4. Promoted rows are written to pipeline.md -> PipelineEntry[]
 *
 * CONTRACTS ONLY. No runtime.
 */

/* -------------------------------------------------------------------------- */
/*  Raw listing data                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One row from the newgrad-jobs.com listing table, as extracted by the
 * content script. Field names mirror the site's column headers.
 */
export interface NewGradRow {
  /** Row position in the listing table (1-based). */
  position: number;
  /** Job title as displayed in the listing. */
  title: string;
  /** Relative time string, e.g. "2d ago", "1w ago". */
  postedAgo: string;
  /** Direct link to the external application page. */
  applyUrl: string;
  /** Link to the newgrad-jobs.com detail page for this listing. */
  detailUrl: string;
  /** Remote, hybrid, on-site, or as displayed on the site. */
  workModel: string;
  /** Location string, e.g. "San Francisco, CA" or "Remote". */
  location: string;
  /** Company name. */
  company: string;
  /** Salary or compensation range as displayed, if available. */
  salary: string | null;
  /** Company size bucket, e.g. "51-200", "1001-5000". */
  companySize: string | null;
  /** Industry label, e.g. "Software Development". */
  industry: string | null;
  /** Qualification summary text, if listed. */
  qualifications: string | null;
  /** Whether the listing indicates H-1B visa sponsorship. */
  h1bSponsored: boolean;
  /** Whether the listing is tagged as new-grad eligible. */
  isNewGrad: boolean;
}

/**
 * Enriched data from the detail or apply page. Contains structured
 * fields that are only available after navigating to the listing's
 * detail URL.
 */
export interface NewGradDetail {
  /** Row position from the original listing, for correlation. */
  position: number;
  /** Job title from the detail page (may differ from listing). */
  title: string;
  /** Company name from the detail page. */
  company: string;
  /** Full location string from the detail page. */
  location: string;
  /** Employment type, e.g. "Full-time", "Contract", "Internship". */
  employmentType: string | null;
  /** Work model from the detail page, e.g. "Remote", "Hybrid". */
  workModel: string | null;
  /** Seniority level, e.g. "Entry level", "Associate". */
  seniorityLevel: string | null;
  /** Salary range as displayed on the detail page. */
  salaryRange: string | null;
  /** Site-computed match score, if displayed (0-100). */
  matchScore: number | null;
  /** Experience level match indicator from the detail page. */
  expLevelMatch: string | null;
  /** Skill match indicator from the detail page. */
  skillMatch: string | null;
  /** Industry experience match indicator. */
  industryExpMatch: string | null;
  /** Full job description text. */
  description: string;
  /** URL of the original listing on the source site. */
  originalPostUrl: string;
  /** Direct "Apply Now" URL from the detail page. */
  applyNowUrl: string;
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Breakdown of how a row's score was computed. Each field corresponds
 * to one scoring dimension.
 */
export interface ScoreBreakdown {
  /** Points earned from role/title keyword matches. */
  roleMatch: number;
  /** Number of skill keywords that matched the listing. */
  skillHits: number;
  /** The actual skill keywords that were found. */
  skillKeywordsMatched: readonly string[];
  /** Points earned from posting recency (newer = higher). */
  freshness: number;
}

/**
 * A listing row after local scoring. Wraps the original row with
 * its computed score and detailed breakdown.
 */
export interface ScoredRow {
  /** The original listing row. */
  row: NewGradRow;
  /** Total computed score. */
  score: number;
  /** Maximum possible score given the current config. */
  maxScore: number;
  /** Per-dimension score breakdown. */
  breakdown: ScoreBreakdown;
}

/**
 * A row that was filtered out during scoring. Captures the reason
 * so the user can understand why a listing was excluded.
 */
export interface FilteredRow {
  /** The original listing row that was filtered. */
  row: NewGradRow;
  /** Machine-readable reason for filtering (e.g. "below_threshold", "title_mismatch"). */
  reason: string;
  /** Optional human-readable detail explaining the filter decision. */
  detail?: string;
}

/* -------------------------------------------------------------------------- */
/*  Scoring results                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Result of the scoring phase: rows that passed the threshold are
 * promoted, rows that didn't are filtered with a reason.
 */
export interface NewGradScoreResult {
  /** Rows that passed the score threshold, sorted by score descending. */
  promoted: readonly ScoredRow[];
  /** Rows that were excluded, with reasons. */
  filtered: readonly FilteredRow[];
}

/* -------------------------------------------------------------------------- */
/*  Enrichment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A listing row combined with its detail-page data after enrichment.
 */
export interface EnrichedRow {
  /** The scored listing row. */
  row: ScoredRow;
  /** Detail data fetched from the listing's detail page. */
  detail: NewGradDetail;
}

/**
 * One entry written to `data/pipeline.md` as a result of the scan.
 */
export interface PipelineEntry {
  /** The job URL added to the pipeline. */
  url: string;
  /** Company name. */
  company: string;
  /** Job title / role. */
  role: string;
  /** Score from the local scorer, for reference. */
  score: number;
  /** Source identifier, e.g. "newgrad-jobs.com". */
  source: string;
}

/**
 * Result of the enrichment + pipeline-write phase.
 */
export interface NewGradEnrichResult {
  /** Number of entries successfully added to the pipeline. */
  added: number;
  /** Number of entries skipped (e.g. duplicates already in pipeline). */
  skipped: number;
  /** The pipeline entries that were written. */
  entries: readonly PipelineEntry[];
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Scoring configuration for the newgrad scanner. Mirrors the structure
 * expected in `config/profile.yml` under `newgrad_scan`.
 */
export interface NewGradScanConfig {
  /** Keywords that match against the job title for role relevance scoring. */
  role_keywords: readonly string[];
  /** Keywords matched against the listing text for skill relevance scoring. */
  skill_keywords: readonly string[];
  /** Freshness scoring parameters. */
  freshness: {
    /** Maximum points awarded for posting recency. */
    max_points: number;
    /** Posts older than this many days receive zero freshness points. */
    max_days: number;
  };
  /** Score thresholds for filtering decisions. */
  thresholds: {
    /** Minimum score (absolute) for a row to be promoted. */
    min_score: number;
    /** Minimum score as a fraction of max_score (0-1) for promotion. */
    min_ratio: number;
  };
  /** Rate-limiting to avoid overloading the source site. */
  throttling: {
    /** Delay in milliseconds between detail-page fetches. */
    delay_ms: number;
    /** Maximum number of detail pages to fetch per scan run. */
    max_enrichments: number;
  };
}
