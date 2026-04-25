#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, Lever APIs, and configured Built In keyword
 * searches, applies title filters from portals.yml, deduplicates against
 * existing history, and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies and evaluate new matches
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --no-evaluate    # write new matches without queueing evaluations
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --no-builtin     # skip Built In keyword searches
 *   node scan.mjs --builtin-only   # scan only Built In keyword searches
 *   node scan.mjs --builtin-only --pages 3
 *   node scan.mjs --evaluate --evaluate-limit 5  # compatibility; evaluation is default
 *   node scan.mjs --builtin-only --evaluate --evaluate-limit 5
 *   node scan.mjs --builtin-only --evaluate-only --evaluate-limit 5
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { pathToFileURL } from 'url';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const PROFILE_PATH = 'config/profile.yml';
const COMPANY_MEMORY_PATH = 'data/newgrad-company-memory.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });
const CONCURRENCY = 10;
const BUILTIN_FETCH_CONCURRENCY = 2;
const FETCH_TIMEOUT_MS = 10_000;
const BUILTIN_SOURCE = 'builtin-scan';
const BUILTIN_BASE_URL = 'https://builtin.com';
const BUILTIN_DEFAULT_PATH = '/jobs/hybrid/national/dev-engineering';
const PROTOCOL_VERSION = '1.0.0';
const DEFAULT_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BRIDGE_PORT = 47319;
const DEFAULT_EVALUATION_QUEUE_DELAY_MS = 2100;
const DEFAULT_EVALUATION_WAIT_TIMEOUT_MS = 20 * 60_000;
const BUILTIN_EVALUATION_PAGE_TEXT_MAX_CHARS = 12_000;
const DEFAULT_BUILTIN_SEARCHES = [
  { name: 'Built In — Software Engineering', keyword: 'Software Engineering', enabled: true },
  { name: 'Built In — Software Engineer', keyword: 'Software Engineer', enabled: true },
  { name: 'Built In — Full Stack Engineer', keyword: 'Full Stack Engineer', enabled: true },
  { name: 'Built In — Backend Engineer', keyword: 'Backend Engineer', enabled: true },
  { name: 'Built In — AI Engineer', keyword: 'AI Engineer', enabled: true },
  { name: 'Built In — Machine Learning Engineer', keyword: 'Machine Learning Engineer', enabled: true },
];

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── Built In keyword search ────────────────────────────────────────

function loadBuiltInSearches(config) {
  const raw = Array.isArray(config.builtin_searches)
    ? config.builtin_searches
    : DEFAULT_BUILTIN_SEARCHES;

  return raw
    .map((entry) => normalizeBuiltInSearch(entry))
    .filter((entry) => entry.enabled !== false && entry.keyword);
}

function normalizeBuiltInSearch(entry) {
  if (typeof entry === 'string') {
    return { name: `Built In — ${entry}`, keyword: entry, enabled: true };
  }

  const keyword = entry.keyword || entry.search || entry.query || entry.name || '';
  return {
    name: entry.name || `Built In — ${keyword}`,
    keyword,
    path: entry.path || BUILTIN_DEFAULT_PATH,
    url: entry.url || null,
    enabled: entry.enabled !== false,
  };
}

function builtInSearchUrl(search, page = 1) {
  const url = search.url
    ? new URL(search.url)
    : new URL(search.path || BUILTIN_DEFAULT_PATH, BUILTIN_BASE_URL);

  url.searchParams.set('search', search.keyword);
  url.searchParams.set('allLocations', 'true');
  url.searchParams.delete('city');
  url.searchParams.delete('state');
  url.searchParams.delete('country');
  url.searchParams.delete('page');
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

function builtInSearchPageUrls(search, pages) {
  return Array.from({ length: pages }, (_, index) => builtInSearchUrl(search, index + 1));
}

function parseBuiltInJobs(html) {
  const jobs = [];
  const seenUrls = new Set();
  const cardRe = /<div id="job-card-\d+"[\s\S]*?(?=<div id="job-card-\d+"|<div class="pagination|<\/main>|$)/g;
  const cards = [...html.matchAll(cardRe)].map(match => match[0]);

  for (const card of cards) {
    const titleLink = matchTitleLink(card);
    if (!titleLink) continue;

    const url = absoluteBuiltInUrl(titleLink.href);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const text = htmlText(card);
    jobs.push({
      title: titleLink.title,
      url,
      company: extractBuiltInCompany(card) || 'Unknown Company',
      location: extractBuiltInLocation(card) || '',
      workModel: extractBuiltInWorkModel(card) || '',
      postedAgo: extractBuiltInPostedAgo(text) || '',
      description: extractBuiltInDescription(card) || '',
      source: BUILTIN_SOURCE,
    });
  }

  if (jobs.length > 0) return jobs;
  return parseBuiltInJsonLdJobs(html);
}

function matchTitleLink(card) {
  const match = card.match(/<a\b(?=[^>]*data-id="job-card-title")(?=[^>]*href="([^"]+)")[^>]*>([\s\S]*?)<\/a>/i);
  if (!match) return null;
  const title = htmlText(match[2] || '');
  if (!title) return null;
  return { href: decodeHtml(match[1] || ''), title };
}

function extractBuiltInCompany(card) {
  const titleMatch = card.match(/<a\b(?=[^>]*data-id="company-title")[^>]*>([\s\S]*?)<\/a>/i);
  const title = titleMatch ? htmlText(titleMatch[1] || '') : '';
  if (title) return title;

  const altMatch = card.match(/alt="([^"]+?)\s+Logo"/i);
  return altMatch ? decodeHtml(altMatch[1] || '').trim() : '';
}

function extractBuiltInLocation(card) {
  const match = card.match(/fa-location-dot[\s\S]{0,700}?<span[^>]*class="font-barlow text-gray-04"[^>]*>([\s\S]*?)<\/span>/i);
  return match ? htmlText(match[1] || '') : '';
}

function extractBuiltInWorkModel(card) {
  const match = card.match(/fa-house-building[\s\S]{0,500}?<span[^>]*class="font-barlow text-gray-04"[^>]*>([\s\S]*?)<\/span>/i);
  return match ? htmlText(match[1] || '') : '';
}

function extractBuiltInPostedAgo(text) {
  const match = text.match(/\b(?:Reposted\s+)?(?:An|\d+)\s+\w+\s+Ago\b|\bYesterday\b/i);
  return match ? match[0].replace(/^Reposted\s+/i, '').trim() : '';
}

function extractBuiltInDescription(card) {
  const match = card.match(/<div class="fs-sm fw-regular mb-md text-gray-04">([\s\S]*?)<\/div>/i);
  return match ? htmlText(match[1] || '') : '';
}

function parseBuiltInJsonLdJobs(html) {
  const jobs = [];
  const scripts = [...html.matchAll(/<script[^>]*type="application\/ld[^"]*"[^>]*>([\s\S]*?)<\/script>/gi)];

  for (const script of scripts) {
    try {
      const parsed = JSON.parse(decodeHtml(script[1] || '').trim());
      const graph = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [parsed];
      for (const item of graph) {
        if (item?.['@type'] !== 'ItemList' || !Array.isArray(item.itemListElement)) continue;
        for (const listItem of item.itemListElement) {
          if (!listItem?.url || !listItem?.name) continue;
          jobs.push({
            title: String(listItem.name),
            url: absoluteBuiltInUrl(String(listItem.url)),
            company: 'Unknown Company',
            location: '',
            workModel: '',
            postedAgo: '',
            description: String(listItem.description || ''),
            source: BUILTIN_SOURCE,
          });
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return jobs;
}

function absoluteBuiltInUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(decodeHtml(value), BUILTIN_BASE_URL);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function htmlText(value) {
  return decodeHtml(String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Company hard filters ────────────────────────────────────────────

export function loadActiveClearanceCompanySkips() {
  const profile = readYamlFile(PROFILE_PATH);
  const hardFilters = profile?.newgrad_scan?.hard_filters || {};
  if (hardFilters.exclude_active_security_clearance !== true) return new Set();

  const memory = readYamlFile(COMPANY_MEMORY_PATH);
  return new Set([
    ...yamlStringArray(hardFilters.active_security_clearance_companies),
    ...yamlStringArray(memory?.active_security_clearance_companies),
  ].map(normalizeCompanyName).filter(Boolean));
}

export function shouldSkipActiveClearanceCompany(company, activeClearanceCompanySkips) {
  return activeClearanceCompanySkips.has(normalizeCompanyName(company));
}

function readYamlFile(path) {
  if (!existsSync(path)) return {};
  try {
    return parseYaml(readFileSync(path, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function yamlStringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function normalizeCompanyName(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function positiveIntOption(args, name, fallback) {
  const raw = optionValue(args, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntOption(args, name, fallback) {
  const raw = optionValue(args, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function formatError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message) {
    return `${error.message}: ${cause.message}`;
  }
  if (cause && typeof cause === 'object') {
    const code = 'code' in cause ? ` ${(cause).code}` : '';
    const message = 'message' in cause ? ` ${(cause).message}` : '';
    const detail = `${code}${message}`.trim();
    if (detail) return `${error.message}: ${detail}`;
  }
  return error.message;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noBuiltIn = args.includes('--no-builtin');
  const builtInOnly = args.includes('--builtin-only');
  const evaluateScan = !args.includes('--no-evaluate');
  const evaluateOnly = args.includes('--evaluate-only');
  const builtInPages = positiveIntOption(args, '--pages', 1);
  const evaluateLimit = positiveIntOption(args, '--evaluate-limit', null);
  const pendingLimit = positiveIntOption(args, '--pending-limit', 100);
  const evaluationQueueDelayMs = nonNegativeIntOption(args, '--evaluation-queue-delay-ms', DEFAULT_EVALUATION_QUEUE_DELAY_MS);
  const evaluationWaitTimeoutMs = positiveIntOption(args, '--evaluation-wait-timeout-ms', DEFAULT_EVALUATION_WAIT_TIMEOUT_MS);
  const bridgeHost = optionValue(args, '--bridge-host') ?? DEFAULT_BRIDGE_HOST;
  const bridgePort = positiveIntOption(args, '--bridge-port', DEFAULT_BRIDGE_PORT);
  const evaluationMode = optionValue(args, '--evaluation-mode') ?? 'newgrad_quick';
  const waitEvaluations = !args.includes('--no-wait-evaluations');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  if (evaluationMode !== 'newgrad_quick' && evaluationMode !== 'default') {
    throw new Error('--evaluation-mode must be newgrad_quick or default');
  }
  if (evaluateOnly && noBuiltIn) {
    throw new Error('--evaluate-only requires Built In scanning; remove --no-builtin');
  }
  if (evaluateOnly && args.includes('--no-evaluate')) {
    throw new Error('--evaluate-only cannot be combined with --no-evaluate');
  }

  if (evaluateOnly) {
    await evaluateBuiltInPending({
      bridgeBase: `http://${bridgeHost}:${bridgePort}`,
      evaluateLimit,
      pendingLimit,
      evaluationMode,
      waitEvaluations,
      evaluationQueueDelayMs,
      evaluationWaitTimeoutMs,
    });
    return;
  }

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const activeClearanceCompanySkips = loadActiveClearanceCompanySkips();
  const builtInSearches = (!noBuiltIn && (!filterCompany || 'builtin'.includes(filterCompany)))
    ? loadBuiltInSearches(config)
    : [];

  // 2. Filter to enabled companies with detectable APIs
  const selectedCompanies = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));
  const activeClearanceSkippedCompanies = builtInOnly
    ? 0
    : selectedCompanies.filter(c => shouldSkipActiveClearanceCompany(c.name, activeClearanceCompanySkips)).length;
  const targets = selectedCompanies
    .filter(c => !shouldSkipActiveClearanceCompany(c.name, activeClearanceCompanySkips))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);
  const apiTargets = builtInOnly ? [] : targets;

  const skippedCount = builtInOnly ? 0 : selectedCompanies.length - activeClearanceSkippedCompanies - targets.length;

  console.log(`Scanning ${apiTargets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (activeClearanceSkippedCompanies > 0) {
    console.log(`Company targets skipped by active-clearance blacklist: ${activeClearanceSkippedCompanies}`);
  }
  console.log(`Scanning ${builtInSearches.length} Built In keyword searches`);
  if (builtInSearches.length > 0) console.log(`Built In pages per search: ${builtInPages}`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let builtInRawFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  let totalActiveClearanceSkipped = 0;
  const newOffers = [];
  const errors = [];

  const tasks = apiTargets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (seenUrls.has(job.url)) {
          totalDupes++;
          continue;
        }
        const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(job.url);
        seenCompanyRoles.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: formatError(err) });
    }
  });

  const builtInTasks = [];
  for (const search of builtInSearches) {
    builtInTasks.push(async () => {
      const pageUrls = builtInSearchPageUrls(search, builtInPages);
      for (const [pageIndex, url] of pageUrls.entries()) {
        try {
          const html = await fetchText(url);
          const jobs = parseBuiltInJobs(html);
          totalFound += jobs.length;
          builtInRawFound += jobs.length;

          for (const job of jobs) {
            if (shouldSkipActiveClearanceCompany(job.company, activeClearanceCompanySkips)) {
              totalActiveClearanceSkipped++;
              continue;
            }
            if (!titleFilter(job.title)) {
              totalFiltered++;
              continue;
            }
            if (seenUrls.has(job.url)) {
              totalDupes++;
              continue;
            }
            const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
            if (seenCompanyRoles.has(key)) {
              totalDupes++;
              continue;
            }
            seenUrls.add(job.url);
            seenCompanyRoles.add(key);
            newOffers.push({ ...job, source: BUILTIN_SOURCE });
          }

          if (jobs.length === 0) break;
        } catch (err) {
          errors.push({
            company: `${search.name} page ${pageIndex + 1}`,
            error: formatError(err),
          });
        }
      }
    });
  }

  await parallelFetch(tasks, CONCURRENCY);
  await parallelFetch(builtInTasks, BUILTIN_FETCH_CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${apiTargets.length}`);
  console.log(`Built In searches:     ${builtInSearches.length}`);
  if (builtInSearches.length > 0) {
    console.log(`Built In pages/search: ${builtInPages}`);
    console.log(`Built In raw jobs:     ${builtInRawFound}`);
  }
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Active-clearance skip: ${totalActiveClearanceSkipped} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  if (evaluateScan) {
    if (dryRun) {
      console.log('\nDirect evaluation is enabled by default, but --dry-run prevents evaluation jobs from being queued.');
    } else if (builtInOnly) {
      await evaluateBuiltInPending({
        bridgeBase: `http://${bridgeHost}:${bridgePort}`,
        evaluateLimit,
        pendingLimit,
        evaluationMode,
        waitEvaluations,
        evaluationQueueDelayMs,
        evaluationWaitTimeoutMs,
      });
    } else {
      await evaluateCurrentScanOffers(newOffers, {
        bridgeBase: `http://${bridgeHost}:${bridgePort}`,
        evaluateLimit,
        evaluationMode,
        waitEvaluations,
        evaluationQueueDelayMs,
        evaluationWaitTimeoutMs,
      });
    }
  }

  if (evaluateScan && !dryRun) {
    if (newOffers.length > 0 || builtInOnly) {
      console.log(`\n→ Direct evaluation enabled; run /career-ops pipeline only for any remaining pending offers.`);
    } else {
      console.log(`\n→ Direct evaluation enabled; no current-run offers were eligible to queue.`);
    }
  } else if (dryRun) {
    console.log(`\n→ Dry run only; no offers were written or evaluated.`);
  } else {
    console.log(`\n→ Run /career-ops pipeline to evaluate new offers, or rerun without --no-evaluate for direct evaluation.`);
  }
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

async function evaluateCurrentScanOffers(offers, options) {
  const entries = dedupeScanOffers(offers);
  const candidates = entries.slice(0, options.evaluateLimit ?? entries.length);

  console.log(`\nCurrent scan offers: total=${entries.length}, evaluating=${candidates.length}`);
  if (candidates.length === 0) return;

  const tokenPath = 'bridge/.bridge-token';
  if (!existsSync(tokenPath)) {
    throw new Error('bridge token not found; start the bridge first with npm run ext:bridge');
  }

  const token = readFileSync(tokenPath, 'utf-8').trim();
  await assertBridgeHealthy(options.bridgeBase, token);

  const queued = [];
  const failed = [];

  for (const [index, candidate] of candidates.entries()) {
    console.log(`Queueing scan evaluation ${index + 1}/${candidates.length}: ${candidate.company} | ${candidate.title}`);
    try {
      const created = await postEnvelope(options.bridgeBase, token, '/v1/evaluate', {
        input: buildScanEvaluationInput(candidate, options.evaluationMode),
      });
      queued.push({
        jobId: created.jobId,
        company: candidate.company,
        role: candidate.title,
      });
    } catch (error) {
      failed.push({
        company: candidate.company,
        role: candidate.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (index < candidates.length - 1 && options.evaluationQueueDelayMs > 0) {
      await sleep(options.evaluationQueueDelayMs);
    }
  }

  console.log(`Scan evaluation queue: queued=${queued.length}, failed=${failed.length}`);
  for (const item of failed) {
    console.warn(`- failed to queue ${item.company} | ${item.role}: ${item.error}`);
  }

  if (options.waitEvaluations && queued.length > 0) {
    const result = await waitForEvaluationJobs(options.bridgeBase, token, queued, options.evaluationWaitTimeoutMs);
    console.log(`Scan evaluation result: completed=${result.completed.length}, failed=${result.failed.length}, timedOut=${result.timedOut.length}`);
    for (const item of result.completed) {
      console.log(`- ${item.result.company} | ${item.result.role}: ${item.result.score}/5 report=${item.result.reportPath} trackerMerged=${item.result.trackerMerged}`);
    }
    for (const item of result.failed) {
      console.warn(`- evaluation failed ${item.job.company} | ${item.job.role}: ${item.error}`);
    }
    for (const item of result.timedOut) {
      console.warn(`- evaluation timed out ${item.company} | ${item.role}`);
    }
  } else if (queued.length > 0) {
    console.log('Evaluation jobs queued; not waiting because --no-wait-evaluations was set.');
  }
}

function buildScanEvaluationInput(entry, evaluationMode) {
  return {
    url: entry.url,
    title: entry.title,
    evaluationMode,
    structuredSignals: {
      source: entry.source || 'portal-scan',
      company: entry.company,
      role: entry.title,
      ...(entry.location ? { location: entry.location } : {}),
      ...(entry.workModel ? { workModel: entry.workModel } : {}),
      ...(entry.postedAgo ? { postedAgo: entry.postedAgo } : {}),
      ...(entry.description ? {
        responsibilities: signalStrings([entry.description], 1, 400),
      } : {}),
    },
    detection: {
      label: 'job_posting',
      confidence: 0.9,
      signals: ['portal-scan', entry.source || 'unknown-source'],
    },
  };
}

function dedupeScanOffers(offers) {
  const seen = new Set();
  const unique = [];
  for (const offer of offers) {
    if (!offer?.url || !offer?.title || !offer?.company) continue;
    const keys = pendingEntryKeys({
      url: offer.url,
      company: offer.company,
      role: offer.title,
    });
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    unique.push(offer);
  }
  return unique;
}

async function evaluateBuiltInPending(options) {
  const tokenPath = 'bridge/.bridge-token';
  if (!existsSync(tokenPath)) {
    throw new Error('bridge token not found; start the bridge first with npm run ext:bridge');
  }

  const token = readFileSync(tokenPath, 'utf-8').trim();
  await assertBridgeHealthy(options.bridgeBase, token);

  const pending = await postEnvelope(options.bridgeBase, token, '/v1/builtin-scan/pending', {
    limit: options.pendingLimit,
  });
  const entries = dedupeBuiltInPendingEntries(pending.entries || []);
  const candidates = entries.slice(0, options.evaluateLimit ?? entries.length);

  console.log(`\nBuilt In pending: total=${pending.total}, eligible=${entries.length}, evaluating=${candidates.length}`);
  if (candidates.length === 0) return;

  const queued = [];
  const failed = [];

  for (const [index, candidate] of candidates.entries()) {
    console.log(`Queueing Built In evaluation ${index + 1}/${candidates.length}: ${candidate.company} | ${candidate.role}`);
    let pageText = '';
    try {
      pageText = await captureBuiltInEvaluationText(candidate);
      if (pageText.length < 1_200) {
        console.log(`  captured short detail text (${pageText.length} chars); bridge may fetch missing details`);
      } else {
        console.log(`  captured detail text (${pageText.length} chars)`);
      }
    } catch (error) {
      console.warn(`  detail capture failed; bridge will evaluate from URL: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const created = await postEnvelope(options.bridgeBase, token, '/v1/evaluate', {
        input: buildBuiltInEvaluationInput(candidate, pageText, options.evaluationMode),
      });
      queued.push({
        jobId: created.jobId,
        company: candidate.company,
        role: candidate.role,
      });
    } catch (error) {
      failed.push({
        company: candidate.company,
        role: candidate.role,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (index < candidates.length - 1 && options.evaluationQueueDelayMs > 0) {
      await sleep(options.evaluationQueueDelayMs);
    }
  }

  console.log(`Built In evaluation queue: queued=${queued.length}, failed=${failed.length}`);
  for (const item of failed) {
    console.warn(`- failed to queue ${item.company} | ${item.role}: ${item.error}`);
  }

  if (options.waitEvaluations && queued.length > 0) {
    const result = await waitForEvaluationJobs(options.bridgeBase, token, queued, options.evaluationWaitTimeoutMs);
    console.log(`Built In evaluation result: completed=${result.completed.length}, failed=${result.failed.length}, timedOut=${result.timedOut.length}`);
    for (const item of result.completed) {
      console.log(`- ${item.result.company} | ${item.result.role}: ${item.result.score}/5 report=${item.result.reportPath} trackerMerged=${item.result.trackerMerged}`);
    }
    for (const item of result.failed) {
      console.warn(`- evaluation failed ${item.job.company} | ${item.job.role}: ${item.error}`);
    }
  } else if (queued.length > 0) {
    console.log('Evaluation jobs queued; not waiting because --no-wait-evaluations was set.');
  }
}

async function assertBridgeHealthy(bridgeBase, token) {
  await getEnvelope(bridgeBase, token, '/v1/health');
  console.log('Bridge health: ok');
}

async function captureBuiltInEvaluationText(entry) {
  const html = await fetchText(entry.url);
  const pageText = htmlText(html).slice(0, BUILTIN_EVALUATION_PAGE_TEXT_MAX_CHARS);
  return [
    `URL: ${entry.url}`,
    `Company: ${entry.company}`,
    `Role: ${entry.role}`,
    entry.score !== undefined ? `Built In pending score: ${entry.score}` : null,
    entry.valueScore !== undefined ? `Local enrich value score: ${entry.valueScore}/10` : null,
    entry.valueReasons?.length ? `Local enrich reasons: ${entry.valueReasons.join(', ')}` : null,
    pageText ? `Built In page text:\n${pageText}` : null,
  ].filter(Boolean).join('\n\n').slice(0, 50_000);
}

function buildBuiltInEvaluationInput(entry, pageText, evaluationMode) {
  return {
    url: entry.url,
    title: entry.role,
    evaluationMode,
    structuredSignals: {
      source: 'builtin.com',
      company: entry.company,
      role: entry.role,
      ...(entry.valueScore !== undefined ? { localValueScore: entry.valueScore } : {}),
      ...(entry.valueReasons?.length ? { localValueReasons: signalStrings(entry.valueReasons, 16, 120) } : {}),
    },
    detection: {
      label: 'job_posting',
      confidence: 1,
      signals: ['builtin-scan'],
    },
    ...(pageText ? { pageText } : {}),
  };
}

function dedupeBuiltInPendingEntries(entries) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const keys = pendingEntryKeys(entry);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function pendingEntryKeys(entry) {
  const keys = [];
  const url = normalizeUrl(entry.url);
  if (url) keys.push(`url:${url}`);
  const company = normalizeSearchValue(entry.company);
  const role = normalizeSearchValue(entry.role);
  if (company || role) keys.push(`company_role:${company}|${role}`);
  return keys.length > 0 ? keys : [`raw:${entry.url}`];
}

async function postEnvelope(bridgeBase, token, path, payload) {
  const res = await fetch(`${bridgeBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-career-ops-token': token,
    },
    body: JSON.stringify({
      protocol: PROTOCOL_VERSION,
      requestId: `scan-${randomUUID()}`,
      clientTimestamp: new Date().toISOString(),
      payload,
    }),
  });
  const body = await res.json();
  if (!body.ok) {
    throw new Error(`${path} failed: ${body.error?.code ?? 'ERROR'} ${body.error?.message ?? ''}`.trim());
  }
  return body.result;
}

async function getEnvelope(bridgeBase, token, path) {
  const res = await fetch(`${bridgeBase}${path}`, {
    headers: { 'x-career-ops-token': token },
  });
  const body = await res.json();
  if (!body.ok) {
    throw new Error(`${path} failed: ${body.error?.code ?? 'ERROR'} ${body.error?.message ?? ''}`.trim());
  }
  return body.result;
}

async function waitForEvaluationJobs(bridgeBase, token, jobs, timeoutMs) {
  const pending = new Map(jobs.map((job) => [job.jobId, job]));
  const completed = [];
  const failed = [];
  const deadline = Date.now() + timeoutMs;

  while (pending.size > 0 && Date.now() < deadline) {
    for (const [jobId, job] of Array.from(pending.entries())) {
      const snapshot = await getEnvelope(bridgeBase, token, `/v1/jobs/${jobId}`);
      if (snapshot.phase === 'completed' && snapshot.result) {
        completed.push({ job, result: snapshot.result });
        pending.delete(jobId);
      } else if (snapshot.phase === 'failed' && snapshot.error) {
        failed.push({ job, error: `${snapshot.error.code} ${snapshot.error.message}` });
        pending.delete(jobId);
      }
    }

    if (pending.size > 0) {
      console.log(`Waiting for evaluations: completed=${completed.length}, failed=${failed.length}, pending=${pending.size}`);
      await sleep(5_000);
    }
  }

  return {
    completed,
    failed,
    timedOut: Array.from(pending.values()),
  };
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function normalizeSearchValue(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function signalStrings(values, maxItems, maxLength) {
  return values
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((value) => value.length > maxLength ? value.slice(0, maxLength).trimEnd() : value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
