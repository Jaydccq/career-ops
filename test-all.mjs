#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-ops
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, data contract, personal data, paths.
 *
 * Usage:
 *   node test-all.mjs           # Run all tests
 *   node test-all.mjs --quick   # Compatibility alias; runs the same checks
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

function run(cmd, args = [], opts = {}) {
  try {
    if (Array.isArray(args) && args.length > 0) {
      return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
    }
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function fileExists(path) { return existsSync(join(ROOT, path)); }
function readFile(path) { return readFileSync(join(ROOT, path), 'utf-8'); }

console.log('\n🧪 career-ops test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

const providerFiles = existsSync(join(ROOT, 'providers'))
  ? readdirSync(join(ROOT, 'providers')).filter(f => f.endsWith('.mjs')).map(f => `providers/${f}`)
  : [];
const mjsFiles = [
  ...readdirSync(ROOT).filter(f => f.endsWith('.mjs')),
  ...providerFiles,
];
for (const f of mjsFiles) {
  const result = run('node', ['--check', f]);
  if (result !== null) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors`);
  }
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

const scripts = [
  { name: 'cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without cv.md (normal in repo)
  { name: 'verify-pipeline.mjs', expectExit: 0 },
  { name: 'normalize-statuses.mjs', expectExit: 0 },
  { name: 'dedup-tracker.mjs', expectExit: 0 },
  { name: 'merge-tracker.mjs', expectExit: 0 },
  { name: 'update-system.mjs check', expectExit: 0 },
];

for (const { name, allowFail } of scripts) {
  const result = run('node', name.split(' '), { stdio: ['pipe', 'pipe', 'pipe'] });
  if (result !== null) {
    pass(`${name} runs OK`);
  } else if (allowFail) {
    warn(`${name} exited with error (expected without user data)`);
  } else {
    fail(`${name} crashed`);
  }
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 3A. SCANNER PROVIDERS ───────────────────────────────────────

console.log('\n3A. Scanner provider parsing');

try {
  const {
    detectApi,
    parseAmazon,
    isRawAtsCareersUrl,
    buildBrandedCareersWarnings,
  } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const {
    buildA16zSearchPayload,
    mapA16zJobToScanOffer,
  } = await import(pathToFileURL(join(ROOT, 'providers/job-board-a16z.mjs')).href);
  const {
    buildTheirStackSearchPayload,
    hasRequiredTheirStackFilter,
    mapTheirStackJobToScanOffer,
  } = await import(pathToFileURL(join(ROOT, 'providers/job-board-theirstack.mjs')).href);

  const amazonApi = detectApi({
    name: 'Amazon Jobs',
    careers_url: 'https://www.amazon.jobs/en/search?base_query=software+engineer',
  });
  const amazonGlobalApi = detectApi({
    name: 'Amazon Jobs',
    careers_url: 'https://www.amazon.jobs/en/search?base_query=software+engineer',
    country: 'ALL',
  });
  const amazonJobs = parseAmazon({
    jobs: [{
      title: 'Software Development Engineer',
      job_path: '/en/jobs/123/software-development-engineer',
      normalized_location: 'Seattle, WA, USA',
      country_code: 'USA',
    }, {
      title: 'Software Engineer, Global',
      job_path: '/en/jobs/456/software-engineer-global',
      normalized_location: 'Cambridge, England, GBR',
      country_code: 'GBR',
    }],
  }, 'Amazon', amazonApi);

  const a16zPayload = buildA16zSearchPayload({
    size: 12,
    markets: ['Artificial Intelligence'],
    locations: [{ label: 'United States', value: 'us' }],
    remoteOnly: true,
  });
  const a16zOffer = mapA16zJobToScanOffer({
    title: 'AI Engineer',
    url: 'https://jobs.a16z.com/companies/example/jobs/1',
    companyName: 'Example AI',
    normalizedLocations: [{ label: 'San Francisco', value: 'sf' }],
  });

  const theirStackPayload = buildTheirStackSearchPayload({
    size: 5,
    posted_at_max_age_days: 7,
    job_country_code_or: ['US'],
  });
  const theirStackOffer = mapTheirStackJobToScanOffer({
    job_title: 'Machine Learning Engineer',
    final_url: 'https://example.com/jobs/ml-engineer',
    company: 'Example Co',
    short_location: 'New York, NY',
  });

  const brandedWarnings = buildBrandedCareersWarnings([
    { name: 'Mastercard', careers_url: 'https://mastercard.wd1.myworkdayjobs.com/jobs' },
    { name: 'Allowed ATS', careers_url: 'https://allowed.myworkdayjobs.com/jobs', allow_raw_ats_careers_url: true },
    { name: 'OpenAI', careers_url: 'https://openai.com/careers' },
  ]);

  if (
    amazonApi?.type === 'amazon' &&
    amazonApi.url.includes('/search.json?') &&
    amazonApi.url.includes('country%5B%5D=USA') &&
    amazonApi.countryCodes.includes('USA') &&
    !amazonGlobalApi.url.includes('country%5B%5D=USA') &&
    amazonGlobalApi.countryCodes === null &&
    amazonJobs.length === 1 &&
    amazonJobs[0]?.url === 'https://www.amazon.jobs/en/jobs/123/software-development-engineer' &&
    a16zPayload.meta.size === 12 &&
    a16zPayload.query.markets[0] === 'Artificial Intelligence' &&
    a16zPayload.query.locations[0] === 'us' &&
    a16zPayload.query.remoteOnly === true &&
    a16zOffer?.company === 'Example AI' &&
    theirStackPayload.limit === 5 &&
    theirStackPayload.posted_at_max_age_days === 7 &&
    hasRequiredTheirStackFilter(theirStackPayload) &&
    theirStackOffer?.url === 'https://example.com/jobs/ml-engineer' &&
    isRawAtsCareersUrl('https://foo.myworkdayjobs.com/jobs') &&
    brandedWarnings.length === 1 &&
    brandedWarnings[0].company === 'Mastercard'
  ) {
    pass('Scanner providers build URLs/payloads and normalize offers');
  } else {
    fail('Scanner provider parsing returned unexpected output');
  }
} catch (e) {
  fail(`Scanner provider tests crashed: ${e.message}`);
}

// ── 3B. DASHBOARD GMAIL SIGNALS ────────────────────────────────

console.log('\n3B. Dashboard Gmail signal parsing');

try {
  const { parseGmailSignals, parseProfile, parseGmailRefreshStatus } = await import(pathToFileURL(join(ROOT, 'web/build-dashboard.mjs')).href);
  const { parseRefreshCommand, summarizeGmailSignals } = await import(pathToFileURL(join(ROOT, 'scripts/refresh-gmail-signals.mjs')).href);
  const { classifyEvent, extractSignalFromMessage, isGmailApiSetupError, isValidStoredSignal, mergeSignals, parseOAuthCallback, readOAuthClient } = await import(pathToFileURL(join(ROOT, 'scripts/gmail-oauth-refresh.mjs')).href);
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-gmail-signals-'));
  const fixture = join(tmp, 'gmail-signals.jsonl');
  const profileFixture = join(tmp, 'profile.yml');
  const statusFixture = join(tmp, 'gmail-refresh-status.json');
  writeFileSync(fixture, [
    '# query: newer_than:30d application',
    JSON.stringify({
      id: 'msg-1:interview',
      applicationNum: 42,
      company: 'Example Co',
      role: 'Software Engineer',
      eventType: 'interview',
      eventDate: '2026-04-25',
      summary: 'Recruiter sent interview scheduling link',
    }),
    '{not json}',
    '',
  ].join('\n'));
  writeFileSync(profileFixture, 'candidate:\n  email: "candidate@example.com"\n');
  writeFileSync(statusFixture, JSON.stringify({
    status: 'skipped',
    message: 'fixture',
    signalSummary: { rows: 1, errors: 1 },
  }));
  const parsed = parseGmailSignals(fixture);
  const profile = parseProfile(profileFixture);
  const refreshStatus = parseGmailRefreshStatus(statusFixture);
  const refreshCommand = parseRefreshCommand('["node","scripts/gmail-oauth-refresh.mjs"]');
  const signalSummary = summarizeGmailSignals(fixture);
  const encodeGmailPart = (text) => Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const gmailMessage = ({ id, from, subject, snippet, text }) => ({
    id,
    threadId: `${id}-thread`,
    internalDate: String(Date.parse('2026-04-24T20:00:00Z')),
    snippet,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Fri, 24 Apr 2026 20:00:00 +0000' },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: encodeGmailPart(text) } }],
    },
  });
  const extracted = extractSignalFromMessage(gmailMessage({
    id: 'gmail-msg-1',
    from: 'Richard Barella from Arista Networks <notifications@arista.com>',
    subject: 'Interview invitation for Application Engineer position',
    snippet: 'Your meeting is scheduled for April 29, 2026 at 3:15 PM PDT.',
    text: 'Thank you for applying to the Application Engineer position at Arista Networks. Your meeting is scheduled.',
  }));
  const marketingOffer = extractSignalFromMessage(gmailMessage({
    id: 'gmail-msg-marketing',
    from: 'Marketing <marketing@jetblue.com>',
    subject: 'Ends Soon: Earn 70,000 bonus points. See if you pre-qualify.',
    snippet: 'Apply for the JetBlue Plus Card. Offer ends soon.',
    text: 'Apply for the JetBlue Plus Card. Terms apply. Offer Ends Soon after qualifying account activity.',
  }));
  const redditDigest = extractSignalFromMessage(gmailMessage({
    id: 'gmail-msg-reddit',
    from: 'Reddit <noreply@redditmail.com>',
    subject: '"Marriott General Accountant interview -- no hotel experience"',
    snippet: 'r/marriott discussion about an interview.',
    text: 'r/marriott: I landed an interview for a General Accountant role at Marriott and want advice.',
  }));
  const talentNewsletter = extractSignalFromMessage(gmailMessage({
    id: 'gmail-msg-talent-newsletter',
    from: 'Talent Northern Trust <talent@ntrs.com>',
    subject: 'Talent Community updates from Northern Trust. Opportunities and more...',
    snippet: 'Northern Trust Career Opportunities email banner.',
    text: 'Northern Trust Career Opportunities email banner. Read interview tips and see what is new in our talent community.',
  }));
  const jobviteApplicationReview = extractSignalFromMessage(gmailMessage({
    id: 'gmail-msg-jobvite-review',
    from: 'Davis Wright Tremaine LLP Recruiting Team <notification@jobvite.com>',
    subject: 'Your application for AI Developer at Davis Wright Tremaine LLP',
    snippet: 'We have received your application and our hiring team is currently reviewing all applications.',
    text: 'Dear Hongxi, Thank you for your interest in a career with Davis Wright Tremaine LLP! We have received your application for our AI Developer position. Our hiring team is currently reviewing all applications.',
  }));
  const conditionalInterviewReceipt = extractSignalFromMessage(gmailMessage({
    id: 'gmail-msg-conditional-interview',
    from: 'no-reply@us.greenhouse-mail.io',
    subject: 'Thank you for applying to DeepIntent',
    snippet: 'Your application has been received. If your application seems like a good match we will contact you soon to schedule an interview.',
    text: 'Hongxi, Thanks for applying to DeepIntent. Your application has been received. If your application seems like a good match for the position we will contact you soon to schedule an interview.',
  }));
  const careersNewsletter = extractSignalFromMessage(gmailMessage({
    id: 'gmail-msg-careers-newsletter',
    from: 'Sarah Butcher <emails@efinancialcareers.com>',
    subject: "Sunday 'Spresso: All our Morning Coffees are here",
    snippet: 'Your weekly roundup of all the latest news and advice.',
    text: 'Your weekly roundup of all the latest news and advice about compensation, hiring, job offers, and interviews.',
  }));
  const realOffer = extractSignalFromMessage(gmailMessage({
    id: 'gmail-msg-offer',
    from: 'Recruiting <recruiting@example.com>',
    subject: 'Offer letter for Software Engineer position',
    snippet: 'We are pleased to extend you an offer.',
    text: 'Congratulations, we are pleased to extend you an offer for the Software Engineer position at Example Co.',
  }));
  const mergedSignals = mergeSignals([{ id: 'gmail-msg-1:interview', company: 'Old' }], [extracted]);
  const storedMarketingValid = isValidStoredSignal({
    eventType: 'offer',
    sender: 'Marketing <marketing@jetblue.com>',
    subject: 'Ends Soon: Earn 70,000 bonus points. See if you pre-qualify.',
    summary: 'Apply for the JetBlue Plus Card. Offer Ends Soon after qualifying account activity.',
  });
  const bareOfferClassified = classifyEvent({
    subject: 'Exclusive intro offer: Up to 4% cash back plus a $200 bonus.',
    text: 'Automatically earn unlimited cash back with this AAA Cashback Card. View in browser.',
  });
  const redirectUri = 'http://127.0.0.1:54609/oauth2callback';
  const emptyCallback = parseOAuthCallback('/oauth2callback', redirectUri, 'expected-state');
  const validCallback = parseOAuthCallback('/oauth2callback?state=expected-state&code=abc123', redirectUri, 'expected-state');
  const mismatchCallback = parseOAuthCallback('/oauth2callback?state=wrong&code=abc123', redirectUri, 'expected-state');
  const webCredentialsFixture = join(tmp, 'web-client.json');
  writeFileSync(webCredentialsFixture, JSON.stringify({
    web: {
      client_id: 'web-client.apps.googleusercontent.com',
      client_secret: 'secret',
    },
  }));
  let rejectedWebClient = false;
  try {
    readOAuthClient(webCredentialsFixture);
  } catch (error) {
    rejectedWebClient = error.setupRequired && error.message.includes('Desktop app');
  }
  rmSync(tmp, { recursive: true, force: true });
  if (
    parsed.rows.length === 1 &&
    parsed.errors.length === 1 &&
    profile.email === 'candidate@example.com' &&
    refreshStatus?.status === 'skipped' &&
    refreshCommand.join(' ') === 'node scripts/gmail-oauth-refresh.mjs' &&
    signalSummary.rows === 1 &&
    signalSummary.errors === 1 &&
    extracted?.eventType === 'interview' &&
    extracted?.company === 'Arista Networks' &&
    extracted?.role === 'Application Engineer' &&
    marketingOffer === null &&
    redditDigest === null &&
    talentNewsletter === null &&
    careersNewsletter === null &&
    jobviteApplicationReview?.eventType === 'applied' &&
    jobviteApplicationReview?.company === 'Davis Wright Tremaine LLP' &&
    jobviteApplicationReview?.role === 'AI Developer' &&
    conditionalInterviewReceipt?.eventType === 'applied' &&
    conditionalInterviewReceipt?.company === 'DeepIntent' &&
    realOffer?.eventType === 'offer' &&
    realOffer?.company === 'Example Co' &&
    realOffer?.role === 'Software Engineer' &&
    storedMarketingValid === false &&
    bareOfferClassified === '' &&
    mergedSignals.length === 1 &&
    mergedSignals[0].company === 'Arista Networks' &&
    emptyCallback.status === 'waiting' &&
    validCallback.status === 'success' &&
    validCallback.code === 'abc123' &&
    mismatchCallback.status === 'state_mismatch' &&
    rejectedWebClient &&
    isGmailApiSetupError('Gmail API has not been used in project 123 before or it is disabled.')
  ) {
    pass('Dashboard Gmail signal/profile/refresh parsers and OAuth classifier keep valid rows');
  } else {
    fail(`Dashboard Gmail parsers returned rows=${parsed.rows.length}, errors=${parsed.errors.length}, email="${profile.email}"`);
  }
} catch (e) {
  fail(`Dashboard Gmail signal parsing tests crashed: ${e.message}`);
}

// ── 4. DATA CONTRACT ────────────────────────────────────────────

console.log('\n4. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'VERSION', 'DATA_CONTRACT.md',
  'modes/_shared.md', 'modes/_profile.template.md',
  'modes/oferta.md', 'modes/pdf.md', 'modes/scan.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/career-ops/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Check user files are NOT tracked (gitignored)
const userFiles = [
  'config/profile.yml', 'modes/_profile.md', 'portals.yml', 'data/gmail-signals.jsonl', 'data/gmail-refresh-status.json',
  'config/gmail-oauth-credentials.json', 'config/gmail-oauth-token.json',
];
for (const f of userFiles) {
  const tracked = run('git', ['ls-files', f]);
  if (tracked === '') {
    pass(`User file gitignored: ${f}`);
  } else if (tracked === null) {
    pass(`User file gitignored: ${f}`);
  } else {
    fail(`User file IS tracked (should be gitignored): ${f}`);
  }
}

// ── 5. PERSONAL DATA LEAK CHECK ─────────────────────────────────

console.log('\n5. Personal data leak check');

const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/',
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // Root project docs that legitimately credit upstream origin.
  'README.md',
  // Standard project files
  'LICENSE', 'CITATION.cff',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'go.mod', 'test-all.mjs',
  '.github/SECURITY.md',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
const grepPathspec = scanExtensions.map(e => `'*.${e}'`).join(' ');

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run(
    `git grep -n "${pattern}" -- ${grepPathspec} 2>/dev/null`
  );
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No personal data leaks outside allowed files');
}

// ── 6. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n6. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
const absPathResult = run(
  `git grep -n "/Users/" -- '*.mjs' '*.sh' '*.md' '*.go' '*.yml' 2>/dev/null | grep -v README.md | grep -v LICENSE | grep -v CLAUDE.md | grep -v test-all.mjs`
);
if (!absPathResult) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathResult.split('\n').filter(Boolean)) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
}

// ── 7. MODE FILE INTEGRITY ──────────────────────────────────────

console.log('\n7. Mode file integrity');

const expectedModes = [
  '_shared.md', '_profile.template.md', 'oferta.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'auto-pipeline.md', 'contacto.md', 'deep.md',
  'ofertas.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
  'gmail-scan.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// Check _shared.md references _profile.md
const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does NOT reference _profile.md');
}

const careerOpsSkill = readFile('.claude/skills/career-ops/SKILL.md');
if (careerOpsSkill.includes('gmail-scan') && careerOpsSkill.includes('modes/{mode}.md')) {
  pass('career-ops skill routes gmail-scan mode');
} else {
  fail('career-ops skill does not route gmail-scan mode');
}

// ── 8. CLAUDE.md INTEGRITY ──────────────────────────────────────

console.log('\n8. CLAUDE.md integrity');

const claude = readFile('CLAUDE.md');
const requiredSections = [
  'Data Contract', 'Update Check', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (claude.includes(section)) {
    pass(`CLAUDE.md has section: ${section}`);
  } else {
    fail(`CLAUDE.md missing section: ${section}`);
  }
}

// ── 9. VERSION FILE ─────────────────────────────────────────────

console.log('\n9. Version file');

if (fileExists('VERSION')) {
  const version = readFile('VERSION').trim();
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

// ── SUMMARY ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('🟡 Tests passed with warnings — review before pushing\n');
  process.exit(0);
} else {
  console.log('🟢 All tests passed — safe to push/merge\n');
  process.exit(0);
}
