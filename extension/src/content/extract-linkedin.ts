/**
 * DOM extractors for LinkedIn Jobs search and detail pages.
 *
 * Exported functions are self-contained so they can be stringified and executed
 * through bb-browser eval. They only read page state; they never click Apply,
 * Save, Dismiss, message, or other mutating controls.
 */

export interface LinkedInRow {
  source?: string;
  position: number;
  title: string;
  postedAgo: string;
  applyUrl: string;
  detailUrl: string;
  workModel: string;
  location: string;
  company: string;
  salary: string | null;
  companySize: string | null;
  industry: string | null;
  qualifications: string | null;
  h1bSponsored: boolean;
  sponsorshipSupport: "yes" | "no" | "unknown";
  confirmedSponsorshipSupport: "yes" | "no" | "unknown";
  requiresActiveSecurityClearance: boolean;
  confirmedRequiresActiveSecurityClearance: boolean;
  isNewGrad: boolean;
}

export interface LinkedInDetail {
  position: number;
  title: string;
  company: string;
  location: string;
  employmentType: string | null;
  workModel: string | null;
  seniorityLevel: string | null;
  salaryRange: string | null;
  matchScore: number | null;
  expLevelMatch: number | null;
  skillMatch: number | null;
  industryExpMatch: number | null;
  description: string;
  industries: readonly string[];
  recommendationTags: readonly string[];
  responsibilities: readonly string[];
  requiredQualifications: readonly string[];
  skillTags: readonly string[];
  taxonomy: readonly string[];
  companyWebsite: string | null;
  companyDescription: string | null;
  companySize: string | null;
  companyLocation: string | null;
  companyFoundedYear: string | null;
  companyCategories: readonly string[];
  h1bSponsorLikely: boolean | null;
  sponsorshipSupport: "yes" | "no" | "unknown";
  confirmedSponsorshipSupport: "yes" | "no" | "unknown";
  h1bSponsorshipHistory: readonly { year: string; count: number }[];
  requiresActiveSecurityClearance: boolean;
  confirmedRequiresActiveSecurityClearance: boolean;
  insiderConnections: number | null;
  originalPostUrl: string;
  applyNowUrl: string;
  applyFlowUrls: readonly string[];
}

export async function extractLinkedInList(): Promise<LinkedInRow[]> {
  const INITIAL_SETTLE_MS = 600;
  const SCROLL_SETTLE_MS = 250;
  const MAX_SCROLL_STEPS = 10;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function text(el: Element | null | undefined): string {
    if (!el) return "";
    return ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
  }

  function compact(value: string): string {
    return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  }

  function lines(value: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of value.split(/\r?\n/)) {
      const line = compact(raw);
      if (!line) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(line);
    }
    return result;
  }

  function linkedInJobId(value: string | null | undefined): string {
    const raw = value?.trim();
    if (!raw) return "";
    if (/^\d+$/.test(raw)) return raw;
    try {
      const parsed = new URL(raw, window.location.href);
      const currentJobId = parsed.searchParams.get("currentJobId");
      if (currentJobId && /^\d+$/.test(currentJobId)) return currentJobId;
      const pathMatch = parsed.pathname.match(/\/jobs\/view\/(\d+)(?:\/|$)/i);
      if (pathMatch?.[1]) return pathMatch[1];
    } catch {
      // Fall through to raw-pattern extraction.
    }
    return raw.match(/\/jobs\/view\/(\d+)(?:[/?#]|$)/i)?.[1] ?? "";
  }

  function canonicalJobUrl(jobId: string): string {
    return `https://www.linkedin.com/jobs/view/${jobId}/`;
  }

  function normalizePostedAgo(value: string): string {
    const normalized = compact(value).replace(/^posted\s+/i, "");
    if (/\b(just now|today|moments ago|a moment ago)\b/i.test(normalized)) return "today";
    if (/\b(?:reposted\s+)?an?\s+minute\s+ago\b/i.test(normalized)) return "1 minute ago";
    if (/\b(?:reposted\s+)?an?\s+hour\s+ago\b/i.test(normalized)) return "1 hour ago";
    if (/\byesterday\b/i.test(normalized)) return "1 day ago";
    const match = normalized.match(
      /\b(?:reposted\s+)?(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s+ago\b/i,
    );
    if (!match) return "";
    const amount = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    if (unit.startsWith("min")) return `${amount} minute${amount === 1 ? "" : "s"} ago`;
    if (unit.startsWith("hr") || unit.startsWith("hour")) return `${amount} hour${amount === 1 ? "" : "s"} ago`;
    if (unit.startsWith("day")) return `${amount} day${amount === 1 ? "" : "s"} ago`;
    if (unit.startsWith("week")) return `${amount} week${amount === 1 ? "" : "s"} ago`;
    if (unit.startsWith("month")) return `${amount} month${amount === 1 ? "" : "s"} ago`;
    return "";
  }

  function workModelFromText(value: string): string {
    if (/\bremote\b/i.test(value)) return "Remote";
    if (/\bhybrid\b/i.test(value)) return "Hybrid";
    if (/\b(on-site|onsite)\b/i.test(value)) return "On-site";
    return "";
  }

  function salaryFromText(value: string): string | null {
    const match = compact(value).match(
      /\$\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s*(?:k|K)?\s*(?:\/\s?(?:yr|year|hr|hour))?\s*[-–]\s*\$\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s*(?:k|K)?(?:\s*\/\s?(?:yr|year|hr|hour))?/i,
    );
    return match?.[0] ? compact(match[0]) : null;
  }

  function requiresActiveClearance(value: string): boolean {
    const normalized = compact(value).toLowerCase();
    if (!/(security clearance|secret clearance|top secret|ts\/sci|sci clearance)/.test(normalized)) return false;
    if (/\b(ability to obtain|eligible to obtain|obtain and maintain|preferred|nice to have|public trust)\b/.test(normalized)) {
      return false;
    }
    return true;
  }

  function sponsorshipStatus(value: string): "yes" | "no" | "unknown" {
    const normalized = compact(value).toLowerCase();
    if (
      normalized.includes("no sponsorship") ||
      normalized.includes("without sponsorship") ||
      normalized.includes("unable to sponsor") ||
      normalized.includes("cannot sponsor") ||
      normalized.includes("will not sponsor") ||
      normalized.includes("sponsorship not available")
    ) {
      return "no";
    }
    if (
      normalized.includes("visa sponsorship available") ||
      normalized.includes("sponsorship available") ||
      normalized.includes("will sponsor") ||
      normalized.includes("immigration support")
    ) {
      return "yes";
    }
    return "unknown";
  }

  function isEarlyCareer(title: string, value: string): boolean {
    return /\b(new grad|new graduate|graduate|university grad|entry level|early career|junior|associate|software engineer i)\b/i
      .test(`${title}\n${value}`);
  }

  function isLocationLine(line: string, workModel: string): boolean {
    if (!line || line.length > 140) return false;
    if (/^(promoted|viewed|easy apply|apply|be an early applicant|actively recruiting)$/i.test(line)) return false;
    if (normalizePostedAgo(line)) return false;
    if (workModel && line.toLowerCase() === workModel.toLowerCase()) return true;
    if (/\b(remote|hybrid|on-site|onsite)\b/i.test(line)) return true;
    if (/\b[A-Z][a-z]+(?: [A-Z][a-z]+)*,\s*[A-Z]{2}\b/.test(line)) return true;
    if (/\bUnited States\b/i.test(line)) return true;
    return /\b\d+\s+locations?\b/i.test(line);
  }

  function cleanTitleFromDismiss(card: Element): string {
    const dismiss = Array.from(card.querySelectorAll<HTMLButtonElement>("button[aria-label]"))
      .find((button) => /^dismiss .+ job$/i.test(button.getAttribute("aria-label") ?? ""));
    const label = dismiss?.getAttribute("aria-label") ?? "";
    return compact(label.replace(/^dismiss\s+/i, "").replace(/\s+job$/i, ""));
  }

  function titleFromCard(card: Element, cardLines: string[]): string {
    const dismissedTitle = cleanTitleFromDismiss(card);
    if (dismissedTitle) return dismissedTitle;

    const anchors = Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href*='/jobs/view/'], a[href*='/jobs/search-results/']"));
    const anchorTitle = anchors
      .map((anchor) => compact(text(anchor)))
      .find((label) => label.length > 1 && label.length <= 180 && !/\b(view|apply|company)\b/i.test(label));
    if (anchorTitle) return anchorTitle;

    return cardLines.find((line) => line.length > 1 && line.length <= 180) ?? "";
  }

  function companyFromLines(cardLines: string[], title: string, location: string, postedAgo: string): string {
    const titleKey = title.toLowerCase();
    for (const line of cardLines) {
      const normalized = line.toLowerCase();
      if (normalized === titleKey) continue;
      if (normalized === `${titleKey} with verification` || /\swith verification$/i.test(line)) continue;
      if (line === location || line === postedAgo) continue;
      if (normalizePostedAgo(line)) continue;
      if (isLocationLine(line, "")) continue;
      if (/^(promoted|viewed|easy apply|apply|be an early applicant|actively recruiting|alumni)$/i.test(line)) continue;
      if (/\b(applicants?|connections?|employees?|followers?|alumni|benefits?)\b/i.test(line)) continue;
      if (line.length > 100) continue;
      return line;
    }
    return "";
  }

  function listScrollTarget(): HTMLElement | null {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(
      ".scaffold-layout__list, .jobs-search-results-list, [role='main'] ul, main",
    ));
    return candidates.find((node) => node.scrollHeight > node.clientHeight + 200) ?? null;
  }

  async function settleVisibleCards(): Promise<void> {
    await sleep(INITIAL_SETTLE_MS);
    const target = listScrollTarget();
    if (!target) return;

    let stable = 0;
    let lastCount = 0;
    for (let i = 0; i < MAX_SCROLL_STEPS && stable < 3; i += 1) {
      const count = document.querySelectorAll("[data-job-id]").length;
      stable = count === lastCount ? stable + 1 : 0;
      lastCount = count;
      target.scrollTo({ top: target.scrollTop + Math.max(500, target.clientHeight - 120), behavior: "auto" });
      await sleep(SCROLL_SETTLE_MS);
    }
    target.scrollTo({ top: 0, behavior: "auto" });
    await sleep(SCROLL_SETTLE_MS);
  }

  await settleVisibleCards();

  const searchIsLastDay = new URLSearchParams(window.location.search).get("f_TPR") === "r86400";
  const seenIds = new Set<string>();
  const rows: LinkedInRow[] = [];
  const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-job-id]"));

  for (const card of cards) {
    const jobId = linkedInJobId(card.getAttribute("data-job-id")) ||
      Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .map((anchor) => linkedInJobId(anchor.href || anchor.getAttribute("href")))
        .find(Boolean) ||
      "";
    if (!jobId || seenIds.has(jobId)) continue;
    seenIds.add(jobId);

    const cardText = text(card);
    const cardLines = lines(cardText);
    const title = titleFromCard(card, cardLines);
    const workModel = workModelFromText(cardText);
    const location = cardLines.find((line) => isLocationLine(line, workModel)) ?? "";
    const postedAgo = normalizePostedAgo(cardText) || (searchIsLastDay ? "today" : "unknown");
    const company = companyFromLines(cardLines, title, location, postedAgo);
    const detailUrl = canonicalJobUrl(jobId);
    const applyUrl = detailUrl;
    const sponsorship = sponsorshipStatus(cardText);

    if (!title || !company) continue;

    rows.push({
      source: "linkedin.com",
      position: rows.length + 1,
      title,
      postedAgo,
      applyUrl,
      detailUrl,
      workModel,
      location,
      company,
      salary: salaryFromText(cardText),
      companySize: null,
      industry: null,
      qualifications: cardText.slice(0, 4000),
      h1bSponsored: sponsorship === "yes",
      sponsorshipSupport: sponsorship,
      confirmedSponsorshipSupport: "unknown",
      requiresActiveSecurityClearance: requiresActiveClearance(cardText),
      confirmedRequiresActiveSecurityClearance: false,
      isNewGrad: isEarlyCareer(title, cardText),
    });
  }

  return rows;
}

export async function extractLinkedInDetail(): Promise<LinkedInDetail> {
  await new Promise((resolve) => window.setTimeout(resolve, 600));

  function text(el: Element | null | undefined): string {
    if (!el) return "";
    return ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
  }

  function compact(value: string): string {
    return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  }

  function lines(value: string): string[] {
    return value
      .split(/\r?\n/)
      .map((line) => compact(line))
      .filter(Boolean);
  }

  function firstText(...selectors: string[]): string {
    for (const selector of selectors) {
      const value = compact(text(document.querySelector(selector)));
      if (value) return value;
    }
    return "";
  }

  function normalizeUrl(value: string | null | undefined): string {
    if (!value) return "";
    try {
      const parsed = new URL(value, window.location.href);
      if (!/^https?:$/.test(parsed.protocol)) return "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "";
    }
  }

  function jobIdFromUrl(value: string): string {
    if (/^\d+$/.test(value.trim())) return value.trim();
    try {
      const parsed = new URL(value, window.location.href);
      const currentJobId = parsed.searchParams.get("currentJobId");
      if (currentJobId && /^\d+$/.test(currentJobId)) return currentJobId;
      return parsed.pathname.match(/\/jobs\/view\/(\d+)(?:\/|$)/i)?.[1] ?? "";
    } catch {
      return value.match(/\/jobs\/view\/(\d+)(?:[/?#]|$)/i)?.[1] ?? "";
    }
  }

  function canonicalCurrentJobUrl(): string {
    const jobId = jobIdFromUrl(window.location.href);
    return jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : normalizeUrl(window.location.href);
  }

  function normalizePostedAgo(value: string): string {
    const normalized = compact(value).replace(/^posted\s+/i, "");
    if (/\b(just now|today|moments ago|a moment ago)\b/i.test(normalized)) return "today";
    if (/\b(?:reposted\s+)?an?\s+minute\s+ago\b/i.test(normalized)) return "1 minute ago";
    if (/\b(?:reposted\s+)?an?\s+hour\s+ago\b/i.test(normalized)) return "1 hour ago";
    if (/\byesterday\b/i.test(normalized)) return "1 day ago";
    const match = normalized.match(
      /\b(?:reposted\s+)?(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s+ago\b/i,
    );
    if (!match) return "";
    const amount = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    if (unit.startsWith("min")) return `${amount} minute${amount === 1 ? "" : "s"} ago`;
    if (unit.startsWith("hr") || unit.startsWith("hour")) return `${amount} hour${amount === 1 ? "" : "s"} ago`;
    if (unit.startsWith("day")) return `${amount} day${amount === 1 ? "" : "s"} ago`;
    if (unit.startsWith("week")) return `${amount} week${amount === 1 ? "" : "s"} ago`;
    if (unit.startsWith("month")) return `${amount} month${amount === 1 ? "" : "s"} ago`;
    return "";
  }

  function workModelFromText(value: string): string | null {
    if (/\bremote\b/i.test(value)) return "Remote";
    if (/\bhybrid\b/i.test(value)) return "Hybrid";
    if (/\b(on-site|onsite)\b/i.test(value)) return "On-site";
    return null;
  }

  function salaryFromText(value: string): string | null {
    const match = compact(value).match(
      /\$\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s*(?:k|K)?\s*(?:\/\s?(?:yr|year|hr|hour))?\s*[-–]\s*\$\s?\d{2,3}(?:,\d{3})?(?:\.\d+)?\s*(?:k|K)?(?:\s*\/\s?(?:yr|year|hr|hour))?/i,
    );
    return match?.[0] ? compact(match[0]) : null;
  }

  function sponsorshipStatus(value: string): "yes" | "no" | "unknown" {
    const normalized = compact(value).toLowerCase();
    if (
      normalized.includes("no sponsorship") ||
      normalized.includes("without sponsorship") ||
      normalized.includes("unable to sponsor") ||
      normalized.includes("cannot sponsor") ||
      normalized.includes("will not sponsor") ||
      normalized.includes("sponsorship not available")
    ) {
      return "no";
    }
    if (
      normalized.includes("visa sponsorship available") ||
      normalized.includes("sponsorship available") ||
      normalized.includes("will sponsor") ||
      normalized.includes("immigration support")
    ) {
      return "yes";
    }
    return "unknown";
  }

  function requiresActiveClearance(value: string): boolean {
    const normalized = compact(value).toLowerCase();
    if (!/(security clearance|secret clearance|top secret|ts\/sci|sci clearance)/.test(normalized)) return false;
    if (/\b(ability to obtain|eligible to obtain|obtain and maintain|preferred|nice to have|public trust)\b/.test(normalized)) {
      return false;
    }
    return true;
  }

  function seniorityFromText(value: string): string | null {
    if (/\b(internship|intern)\b/i.test(value)) return "Internship";
    if (/\b(new grad|new graduate|entry level|early career|junior|associate|software engineer i)\b/i.test(value)) {
      return "Entry level";
    }
    if (/\bmid[-\s]?senior|senior|staff|principal|lead\b/i.test(value)) return "Senior";
    return null;
  }

  function sectionItems(source: string, headingPattern: RegExp): string[] {
    const sourceLines = lines(source);
    const start = sourceLines.findIndex((line) => headingPattern.test(line));
    if (start === -1) return [];

    const items: string[] = [];
    for (const line of sourceLines.slice(start + 1)) {
      if (/^(about|benefits|qualifications|requirements|responsibilities|skills|experience|what you|you will|who you are)$/i.test(line)) {
        if (items.length > 0) break;
        continue;
      }
      const cleaned = compact(line.replace(/^[-•*]\s*/, ""));
      if (cleaned.length < 20 || cleaned.length > 450) continue;
      items.push(cleaned);
      if (items.length >= 10) break;
    }
    return items;
  }

  function skillTagsFromText(value: string): string[] {
    const skills = [
      "TypeScript",
      "JavaScript",
      "Python",
      "React",
      "Node.js",
      "Java",
      "Go",
      "C++",
      "SQL",
      "AWS",
      "Azure",
      "GCP",
      "Kubernetes",
      "Docker",
      "LLM",
      "AI",
      "Machine Learning",
    ];
    const normalized = value.toLowerCase();
    return skills.filter((skill) => normalized.includes(skill.toLowerCase())).slice(0, 14);
  }

  const title = firstText("h1", ".job-details-jobs-unified-top-card__job-title", ".jobs-unified-top-card__job-title");
  const company = firstText(
    ".job-details-jobs-unified-top-card__company-name a",
    ".job-details-jobs-unified-top-card__company-name",
    ".jobs-unified-top-card__company-name a",
    ".jobs-unified-top-card__company-name",
  );
  const topCardText = firstText(
    ".job-details-jobs-unified-top-card",
    ".jobs-unified-top-card",
    ".jobs-search__job-details--container",
  );
  const description = firstText(
    ".jobs-description__content",
    ".jobs-box__html-content",
    ".jobs-description-content__text",
    ".jobs-search__job-details",
    "main",
  ).slice(0, 20_000);
  const pageText = compact(document.body?.innerText ?? "");
  const detailUrl = canonicalCurrentJobUrl();
  const postedAgo = normalizePostedAgo(topCardText || pageText);
  const workModel = workModelFromText(`${topCardText}\n${description}`);
  const locationLine = lines(topCardText)
    .find((line) => /\b[A-Z][a-z]+(?: [A-Z][a-z]+)*,\s*[A-Z]{2}\b/.test(line) || /\bUnited States\b/i.test(line) || /\bRemote\b/i.test(line)) ?? "";
  const sponsorship = sponsorshipStatus(description || pageText);
  const requiresClearance = requiresActiveClearance(description || pageText);
  const requiredQualifications = sectionItems(description, /^(qualifications|requirements|basic qualifications|required qualifications|what you bring)$/i);
  const responsibilities = sectionItems(description, /^(responsibilities|what you will do|you will|about the role)$/i);

  return {
    position: 0,
    title,
    company,
    location: locationLine,
    employmentType: /\b(internship|intern)\b/i.test(`${title}\n${description}`) ? "Internship" : "Full-time",
    workModel,
    seniorityLevel: seniorityFromText(`${title}\n${description}`),
    salaryRange: salaryFromText(description || pageText),
    matchScore: null,
    expLevelMatch: null,
    skillMatch: null,
    industryExpMatch: null,
    description,
    industries: [],
    recommendationTags: postedAgo ? [postedAgo] : [],
    responsibilities,
    requiredQualifications,
    skillTags: skillTagsFromText(description || pageText),
    taxonomy: [],
    companyWebsite: null,
    companyDescription: null,
    companySize: null,
    companyLocation: null,
    companyFoundedYear: null,
    companyCategories: [],
    h1bSponsorLikely: null,
    sponsorshipSupport: sponsorship,
    confirmedSponsorshipSupport: sponsorship,
    h1bSponsorshipHistory: [],
    requiresActiveSecurityClearance: requiresClearance,
    confirmedRequiresActiveSecurityClearance: requiresClearance,
    insiderConnections: null,
    originalPostUrl: detailUrl,
    applyNowUrl: detailUrl,
    applyFlowUrls: [detailUrl],
  };
}
