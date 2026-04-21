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
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --no-builtin     # skip Built In keyword searches
 *   node scan.mjs --builtin-only   # scan only Built In keyword searches
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });
const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;
const BUILTIN_SOURCE = 'builtin-scan';
const BUILTIN_BASE_URL = 'https://builtin.com';
const BUILTIN_DEFAULT_PATH = '/jobs/hybrid/national/dev-engineering';
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

function builtInSearchUrl(search) {
  const url = search.url
    ? new URL(search.url)
    : new URL(search.path || BUILTIN_DEFAULT_PATH, BUILTIN_BASE_URL);

  url.searchParams.set('search', search.keyword);
  url.searchParams.set('allLocations', 'true');
  url.searchParams.delete('city');
  url.searchParams.delete('state');
  url.searchParams.delete('country');
  return url.toString();
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

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noBuiltIn = args.includes('--no-builtin');
  const builtInOnly = args.includes('--builtin-only');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const builtInSearches = (!noBuiltIn && (!filterCompany || 'builtin'.includes(filterCompany)))
    ? loadBuiltInSearches(config)
    : [];

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);
  const apiTargets = builtInOnly ? [] : targets;

  const skippedCount = builtInOnly ? 0 : companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${apiTargets.length} companies via API (${skippedCount} skipped — no API detected)`);
  console.log(`Scanning ${builtInSearches.length} Built In keyword searches`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
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
      errors.push({ company: company.name, error: err.message });
    }
  });

  for (const search of builtInSearches) {
    tasks.push(async () => {
      const url = builtInSearchUrl(search);
      try {
        const html = await fetchText(url);
        const jobs = parseBuiltInJobs(html);
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
          seenUrls.add(job.url);
          seenCompanyRoles.add(key);
          newOffers.push({ ...job, source: BUILTIN_SOURCE });
        }
      } catch (err) {
        errors.push({ company: search.name, error: err.message });
      }
    });
  }

  await parallelFetch(tasks, CONCURRENCY);

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
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
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

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
