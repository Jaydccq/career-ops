export type LinkedInAuthBlock = "login" | "checkpoint" | "authwall";

export interface LinkedInAuthStateInput {
  url?: string | null;
  title?: string | null;
  text?: string | null;
}

const LINKEDIN_HOST_RE = /(^|\.)linkedin\.com$/i;

export function isLinkedInHost(hostname: string | null | undefined): boolean {
  return LINKEDIN_HOST_RE.test((hostname ?? "").toLowerCase());
}

export function extractLinkedInJobId(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!isLinkedInHost(parsed.hostname)) return null;

    const currentJobId = parsed.searchParams.get("currentJobId");
    if (currentJobId && /^\d+$/.test(currentJobId)) return currentJobId;

    const pathMatch = parsed.pathname.match(/\/jobs\/view\/(\d+)(?:\/|$)/i);
    if (pathMatch?.[1]) return pathMatch[1];
  } catch {
    // Fall through to text patterns for raw href fragments.
  }

  const pathMatch = raw.match(/\/jobs\/view\/(\d+)(?:[/?#]|$)/i);
  if (pathMatch?.[1]) return pathMatch[1];

  const paramMatch = raw.match(/[?&]currentJobId=(\d+)(?:[&#]|$)/i);
  return paramMatch?.[1] ?? null;
}

export function canonicalLinkedInJobViewUrl(value: string | null | undefined): string | null {
  const jobId = extractLinkedInJobId(value);
  return jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : null;
}

export function isLinkedInJobsUrl(value: string | null | undefined): boolean {
  return canonicalLinkedInJobViewUrl(value) !== null;
}

export function normalizeLinkedInPostedAgo(value: string | null | undefined): string {
  const normalized = compact(value ?? "").replace(/^posted\s+/i, "");
  if (!normalized) return "unknown";

  if (/\b(just now|today|moments ago|a moment ago)\b/i.test(normalized)) {
    return "today";
  }

  if (/\b(?:reposted\s+)?an?\s+minute\s+ago\b/i.test(normalized)) {
    return "1 minute ago";
  }

  if (/\b(?:reposted\s+)?an?\s+hour\s+ago\b/i.test(normalized)) {
    return "1 hour ago";
  }

  if (/\byesterday\b/i.test(normalized)) {
    return "1 day ago";
  }

  const match = normalized.match(
    /\b(?:reposted\s+)?(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s+ago\b/i,
  );
  if (!match) return "unknown";

  const amount = Number(match[1]);
  const rawUnit = (match[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return "unknown";

  if (rawUnit.startsWith("min")) return `${amount} minute${amount === 1 ? "" : "s"} ago`;
  if (rawUnit.startsWith("hr") || rawUnit.startsWith("hour")) {
    return `${amount} hour${amount === 1 ? "" : "s"} ago`;
  }
  if (rawUnit.startsWith("day")) return `${amount} day${amount === 1 ? "" : "s"} ago`;
  if (rawUnit.startsWith("week")) return `${amount} week${amount === 1 ? "" : "s"} ago`;
  if (rawUnit.startsWith("month")) return `${amount} month${amount === 1 ? "" : "s"} ago`;
  return "unknown";
}

export function parseLinkedInWorkModel(value: string | null | undefined): string {
  const normalized = compact(value ?? "");
  if (!normalized) return "";
  if (/\bremote\b/i.test(normalized)) return "Remote";
  if (/\bhybrid\b/i.test(normalized)) return "Hybrid";
  if (/\b(on-site|onsite)\b/i.test(normalized)) return "On-site";
  return "";
}

export function detectLinkedInAuthBlock(input: LinkedInAuthStateInput): LinkedInAuthBlock | null {
  const url = (input.url ?? "").toLowerCase();
  const title = compact(input.title ?? "").toLowerCase();
  const text = compact(input.text ?? "").toLowerCase();
  const combined = `${title}\n${text}`;

  if (url.includes("/checkpoint/") || /\bsecurity verification\b/.test(combined)) {
    return "checkpoint";
  }

  if (url.includes("/authwall") || /\bauthwall\b/.test(url)) {
    return "authwall";
  }

  if (
    url.includes("/login") ||
    url.includes("/uas/login") ||
    /\bsign in\b/.test(title) ||
    /\bjoin linkedin\b/.test(combined) ||
    /\bsign in to view\b/.test(combined)
  ) {
    return "login";
  }

  return null;
}

function compact(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}
