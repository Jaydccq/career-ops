#!/usr/bin/env node

/**
 * Local PDF companion for the static dashboard.
 *
 * The dashboard itself is browser-only. Real PDF generation requires Node and
 * Playwright, so this loopback-only server accepts Apply Next row data, builds
 * deterministic PDF inputs from repository sources, calls the existing PDF
 * scripts, and copies generated PDFs to ~/Downloads on request.
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import yaml from 'js-yaml';
import { renderDashboardHtml } from './build-dashboard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HOST = process.env.CAREER_OPS_PDF_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.CAREER_OPS_PDF_PORT || '47329', 10);
const AUTH_HEADER = 'x-career-ops-pdf-token';
const API_TOKEN = process.env.CAREER_OPS_PDF_TOKEN || randomUUID();
const OUTPUT_DIR = join(ROOT, 'output');
const WORK_DIR = join(OUTPUT_DIR, '.apply-docs');
const DOWNLOADS_DIR = join(os.homedir(), 'Downloads');
const docStore = new Map();

class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'our', 'that', 'the',
  'their', 'this', 'to', 'using', 'with', 'work', 'role', 'team', 'build',
  'built', 'systems', 'software', 'engineer', 'engineering', 'candidate',
  'strong', 'experience', 'project', 'projects', 'cv', 'jd',
]);

const TECH_TERMS = [
  'AI agents',
  'Agentic workflows',
  'LLM orchestration',
  'Tool orchestration',
  'Workflow orchestration',
  'RAG',
  'Retrieval-Augmented Generation',
  'Vercel AI SDK',
  'Function Calling',
  'pgvector',
  'Vector DB',
  'OpenAI Embeddings',
  'LangChain',
  'Python',
  'PySpark',
  'PyTorch',
  'TypeScript',
  'JavaScript',
  'Java',
  'C++',
  'C++17',
  'C',
  'React',
  'Next.js',
  'Node.js',
  'NestJS',
  'Spring Boot',
  'Spring Security',
  'REST',
  'SQL',
  'PostgreSQL',
  'Postgres',
  'Redis',
  'RabbitMQ',
  'BullMQ',
  'WebSocket',
  'SSE',
  'Docker',
  'AWS',
  'AWS EC2',
  'GitHub Actions',
  'CI/CD',
  'Prometheus',
  'Grafana',
  'Airflow',
  'Linux',
  'epoll',
  'OAuth2',
  'JWT',
  'RBAC',
  'JUnit 5',
  'Valgrind',
  'TailwindCSS',
  'Distributed Systems',
  'Microservices',
  'High-concurrency',
  'Event-driven architecture',
  'Real-time tracking',
  'Observability',
  'Security',
  'Product ownership',
  'AI-native development',
  'harness-engineering',
];

const SUPPORTED_SIGNAL_ALIASES = [
  {
    term: 'AI agents',
    patterns: [/\bAI agent\b/i, /\bagentic\b/i, /\bLLM\b/i, /tool-orchestrat/i],
  },
  {
    term: 'Agentic workflows',
    patterns: [/\bagentic\b/i, /tool-orchestrat/i, /workflow/i, /\bLLM\b/i],
  },
  {
    term: 'LLM orchestration',
    patterns: [/\bLLM\b/i, /Vercel AI SDK/i, /tool-orchestrat/i, /Function Calling/i],
  },
  {
    term: 'Tool orchestration',
    patterns: [/tool-orchestrat/i, /typed tools/i, /Function Calling/i, /Vercel AI SDK/i],
  },
  {
    term: 'Workflow orchestration',
    patterns: [/workflow/i, /orchestrat/i, /BullMQ/i, /Airflow/i],
  },
  {
    term: 'RAG',
    patterns: [/\bRAG\b/i, /retrieval/i, /pgvector/i, /embeddings/i, /vector database/i],
  },
  {
    term: 'Distributed Systems',
    patterns: [/distributed/i, /RabbitMQ/i, /Redis/i, /WebSocket/i, /microservices/i, /concurrent/i, /\bQPS\b/i],
  },
  {
    term: 'High-concurrency',
    patterns: [/high-concurrency/i, /concurrent/i, /\bQPS\b/i, /WebSocket/i, /epoll/i],
  },
  {
    term: 'Event-driven architecture',
    patterns: [/event-driven/i, /RabbitMQ/i, /WebSocket/i, /outbox/i, /message/i],
  },
  {
    term: 'Real-time tracking',
    patterns: [/real-time/i, /WebSocket/i, /\bSSE\b/i, /streaming/i, /tracking/i],
  },
  {
    term: 'Observability',
    patterns: [/Prometheus/i, /Grafana/i, /telemetry/i, /metrics/i, /audit/i, /event log/i],
  },
  {
    term: 'Product ownership',
    patterns: [/owned/i, /shipped/i, /user feedback/i, /customer/i, /retention/i],
  },
  {
    term: 'AI-native development',
    patterns: [/AI-native/i, /Claude Code/i, /Codex/i, /harness-engineering/i],
  },
  {
    term: 'Security',
    patterns: [/OAuth2/i, /\bJWT\b/i, /\bRBAC\b/i, /Spring Security/i, /rate limiting/i, /signature/i],
  },
  {
    term: 'CI/CD',
    patterns: [/CI\/CD/i, /GitHub Actions/i, /deployment/i, /deployed/i],
  },
];

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': `content-type,${AUTH_HEADER}`,
  });
  res.end(body);
}

function sendText(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) {
      throw new ClientError('request body too large', 413);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ClientError('invalid JSON body', 400);
  }
}

function assertApiToken(req) {
  if (req.headers[AUTH_HEADER] !== API_TOKEN) {
    throw new ClientError('missing or invalid PDF API token', 401);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/#+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchText(value) {
  return stripMarkdown(value)
    .toLowerCase()
    .replace(/c\+\+/g, 'cplusplus')
    .replace(/node\.js/g, 'nodejs')
    .replace(/next\.js/g, 'nextjs')
    .replace(/ci\/cd/g, 'cicd')
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasExactSignalTerm(term, text) {
  const rawTerm = stripMarkdown(term);
  if (!rawTerm) return false;
  if (/^[A-Za-z0-9+#./-]{1,16}$/.test(rawTerm)) {
    const escaped = rawTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9+.#])${escaped}([^A-Za-z0-9+.#]|$)`, 'i').test(String(text ?? ''));
  }
  return normalizeSearchText(text).includes(normalizeSearchText(rawTerm));
}

function tokenSet(value) {
  return new Set(normalizeSearchText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}

function meaningfulTokens(value) {
  return [...tokenSet(value)];
}

function scoreTokensAgainstText(value, searchText) {
  const tokens = meaningfulTokens(value);
  if (!tokens.length) return 0;
  const haystack = tokenSet(searchText);
  const matched = tokens.filter((token) => haystack.has(token));
  return matched.length / tokens.length;
}

function requiresLlmWorkflowContext(term) {
  return /^(ai agents?|agentic workflows?|llm orchestration|tool orchestration|workflow orchestration)$/i.test(stripMarkdown(term));
}

function hasLlmWorkflowContext(text) {
  return /\b(LLM|RAG|tool-orchestrat|workflow|Vercel AI SDK|Function Calling|OpenAI|LangChain|agent platform|agentic)\b/i.test(text);
}

function clipText(value, max = 900) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, '')}...`;
}

function slugify(value, fallback = 'document') {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeUrl(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function displayUrl(value) {
  return String(value ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

async function readText(relPath, fallback = '') {
  const abs = join(ROOT, relPath);
  return existsSync(abs) ? readFile(abs, 'utf8') : fallback;
}

async function loadProfile() {
  const raw = await readText('config/profile.yml', '');
  if (!raw.trim()) return {};
  return yaml.load(raw) || {};
}

function resolveReportPath(reportPath) {
  if (!reportPath) return null;
  if (!/^reports\/\d{3}-.+\.md$/.test(reportPath)) {
    throw new ClientError('invalid reportPath');
  }
  const reportsDir = resolve(ROOT, 'reports');
  const abs = resolve(ROOT, reportPath);
  if (!abs.startsWith(`${reportsDir}${sep}`)) {
    throw new ClientError('invalid reportPath');
  }
  if (!existsSync(abs)) {
    throw new ClientError('reportPath does not exist', 404);
  }
  return abs;
}

function extractReportSection(content, letter) {
  const heading = new RegExp(`^##\\s+${letter}\\)\\s+.*$`, 'mi');
  const match = heading.exec(content || '');
  if (!match) return '';
  const rest = content.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+[A-Z]\)\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function parseMarkdownTable(section) {
  const rows = section.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\|.+\|$/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => stripMarkdown(cell)));
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => normalizeSearchText(header));
  return rows.slice(1)
    .filter((cells) => !cells.every((cell) => /^[-:\s]+$/.test(cell)))
    .map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] || ''])));
}

function extractTableValue(section, labels) {
  const rows = parseMarkdownTable(section);
  const wanted = new Set(labels.map((label) => normalizeSearchText(label)));
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length < 2) continue;
    const label = row[keys[0]];
    if (wanted.has(normalizeSearchText(label))) {
      return row[keys[1]];
    }
  }
  return '';
}

function extractListItems(section) {
  return section.split('\n')
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1])
    .filter(Boolean)
    .map(stripMarkdown)
    .filter(Boolean);
}

function splitKeywordLine(value) {
  return String(value ?? '')
    .split(/[,;|]/)
    .map(stripMarkdown)
    .map((item) => item.replace(/^keywords?\s*(extracted|extra[ií]das?)?\s*:?\s*/i, '').trim())
    .filter((item) => item.length > 1);
}

function extractTrailingKeywordSection(reportContent) {
  const match = /(?:^|\n)##\s+Keywords(?:\s+extra[ií]das?| extracted)?\s*\n([\s\S]+)$/i.exec(reportContent || '');
  return match ? splitKeywordLine(match[1]) : [];
}

function extractRequirementRows(reportContent) {
  const rows = parseMarkdownTable(extractReportSection(reportContent, 'B'));
  return rows.map((row) => {
    const keys = Object.keys(row);
    const requirementKey = keys.find((key) => /requirement|requisito|signal/.test(key)) || keys[0];
    const evidenceKey = keys.find((key) => /evidence|proof|cv/.test(key)) || keys[keys.length - 1];
    return {
      requirement: row[requirementKey] || '',
      evidence: row[evidenceKey] || '',
    };
  }).filter((row) => row.requirement);
}

function firstUsefulSentence(markdown) {
  const text = stripMarkdown((markdown || '').split('\n').find((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('|') && !trimmed.startsWith('-') && !trimmed.startsWith('---');
  }) || markdown);
  return clipText(text, 300);
}

function evidenceItemsFromReport(content) {
  return extractRequirementRows(content)
    .slice(0, 4)
    .map((row) => ({ requirement: row.requirement, evidence: row.evidence, match: '' }));
}

function supportsSignal(term, text) {
  const normalizedTerm = normalizeSearchText(term);
  if (!normalizedTerm) return false;
  if (requiresLlmWorkflowContext(term) && !hasLlmWorkflowContext(text)) return false;
  if (hasExactSignalTerm(term, text)) return true;

  const alias = SUPPORTED_SIGNAL_ALIASES.find((entry) => normalizeSearchText(entry.term) === normalizedTerm);
  if (alias?.patterns.some((pattern) => pattern.test(text))) return true;

  const tokenScore = scoreTokensAgainstText(term, text);
  return meaningfulTokens(term).length >= 2 && tokenScore >= 0.67;
}

function scoreSignalAgainstText(term, text) {
  const normalizedTerm = normalizeSearchText(term);
  if (!normalizedTerm) return 0;
  if (requiresLlmWorkflowContext(term) && !hasLlmWorkflowContext(text)) return 0;
  if (hasExactSignalTerm(term, text)) return 8 + meaningfulTokens(term).length;

  const alias = SUPPORTED_SIGNAL_ALIASES.find((entry) => normalizeSearchText(entry.term) === normalizedTerm);
  if (alias?.patterns.some((pattern) => pattern.test(text))) return 6;

  const tokenScore = scoreTokensAgainstText(term, text);
  if (tokenScore >= 0.67) return 4 * tokenScore;
  if (tokenScore >= 0.4) return 1.5 * tokenScore;
  return 0;
}

function extractKnownTechTerms(text) {
  return TECH_TERMS.filter((term) => supportsSignal(term, text));
}

function buildRoleSignals(row, reportContent, cvMarkdown) {
  const sectionA = extractReportSection(reportContent, 'A');
  const sectionD = extractReportSection(reportContent, 'D');
  const sectionE = extractReportSection(reportContent, 'E');
  const sectionH = extractReportSection(reportContent, 'H');
  const requirements = extractRequirementRows(reportContent);
  const jobText = [
    row.company,
    row.role,
    row.notes,
    sectionA,
    sectionD,
    sectionE,
    sectionH,
    ...requirements.map((item) => item.requirement),
  ].join('\n');
  const evidenceText = requirements.map((item) => item.evidence).join('\n');
  const reportText = [jobText, evidenceText].join('\n');

  const rawPhrases = [
    row.role,
    ...extractListItems(sectionD),
    ...extractListItems(sectionE),
    ...extractListItems(sectionH),
    ...extractTrailingKeywordSection(reportContent),
    ...extractKnownTechTerms(jobText),
    ...requirements.map((item) => item.requirement),
  ];

  const supportedPhrases = unique(rawPhrases)
    .filter((term) => term.length <= 90)
    .filter((term) => supportsSignal(term, cvMarkdown));

  return {
    reportText,
    jobText,
    evidenceText,
    requirements,
    supportedPhrases,
    tokens: tokenSet(jobText),
  };
}

function extractKeySkills(reportContent, cvMarkdown, roleSignals) {
  const section = extractReportSection(reportContent, 'D');
  const listed = section.split('\n')
    .map((line) => line.match(/^-\s+(.+)$/)?.[1])
    .filter(Boolean)
    .map(stripMarkdown)
    .filter((term) => term && !/^no skill/i.test(term));

  return unique([
    ...(roleSignals?.supportedPhrases || []),
    ...listed,
    ...extractKnownTechTerms(reportContent),
    ...extractKnownTechTerms(cvMarkdown),
  ])
    .filter((term) => term.length <= 48)
    .filter((term) => supportsSignal(term, cvMarkdown))
    .sort((a, b) => scoreSignalAgainstText(b, roleSignals?.jobText || reportContent) - scoreSignalAgainstText(a, roleSignals?.jobText || reportContent))
    .slice(0, 12);
}

function unique(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const clean = stripMarkdown(item);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function sectionBetween(markdown, heading) {
  const pattern = new RegExp(`^##\\s+${heading}\\s*$`, 'mi');
  const match = pattern.exec(markdown);
  if (!match) return '';
  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function splitSubsections(section) {
  return section
    .split(/^###\s+/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => chunk.split('\n').map((line) => line.trim()).filter(Boolean));
}

function parseWorkEntries(cvMarkdown) {
  return splitSubsections(sectionBetween(cvMarkdown, 'Work Experience')).map((lines) => ({
    company: stripMarkdown(lines[0]),
    role: stripMarkdown(lines[1]),
    location: stripMarkdown(lines[2]),
    period: stripMarkdown(lines[3]),
    bullets: lines.filter((line) => line.startsWith('- ')).map((line) => stripMarkdown(line.slice(2))),
  }));
}

function parseProjectEntries(cvMarkdown) {
  return splitSubsections(sectionBetween(cvMarkdown, 'Project Experience')).map((lines) => {
    const techLine = lines.find((line) => /^\*\*Tech Stack:\*\*/.test(line));
    const nonBulletLines = lines.filter((line) => !line.startsWith('- '));
    const metaLines = nonBulletLines.slice(1).filter((line) => line !== techLine);
    const period = metaLines.find((line) => /\b(20\d{2}|present|jan\.?|feb\.?|mar\.?|apr\.?|may|jun\.?|jul\.?|aug\.?|sep\.?|oct\.?|nov\.?|dec\.?)\b/i.test(line)) || '';
    const description = metaLines.find((line) => line !== period) || '';
    return {
      title: stripMarkdown(lines[0]),
      description: stripMarkdown(description),
      period: stripMarkdown(period),
      tech: stripMarkdown((techLine || '').replace(/^\*\*Tech Stack:\*\*\s*/, '')),
      bullets: lines.filter((line) => line.startsWith('- ')).map((line) => stripMarkdown(line.slice(2))),
    };
  });
}

function parseEducationEntries(cvMarkdown) {
  return splitSubsections(sectionBetween(cvMarkdown, 'Education')).map((lines) => ({
    school: stripMarkdown(lines[0]),
    degree: stripMarkdown(lines[1]),
    location: stripMarkdown(lines[2]),
    period: stripMarkdown(lines[3]),
  }));
}

function parseSkillEntries(cvMarkdown) {
  return splitSubsections(sectionBetween(cvMarkdown, 'Skills')).map((lines) => ({
    category: stripMarkdown(lines[0]),
    skills: stripMarkdown(lines.slice(1).join(', ')),
  })).filter((entry) => entry.category && entry.skills);
}

function projectSearchText(entry) {
  return [
    entry.title,
    entry.description,
    entry.period,
    entry.tech,
    ...(entry.bullets || []),
  ].join(' ');
}

function scoreBullet(bullet, roleSignals) {
  const keywordScore = [...roleSignals.tokens]
    .filter((token) => tokenSet(bullet).has(token))
    .length;
  const phraseScore = roleSignals.supportedPhrases
    .slice(0, 30)
    .reduce((score, phrase) => score + scoreSignalAgainstText(phrase, bullet), 0);
  const metricBoost = /\b\d+(?:\.\d+)?\s*(?:%|ms|K\+?|M\+?|QPS|concurrent|sessions|events|tools|pages|records)\b/i.test(bullet) ? 3 : 0;
  return keywordScore + phraseScore + metricBoost;
}

function matchedProjectTerms(entry, roleSignals, limit = 5) {
  const text = projectSearchText(entry);
  return unique(roleSignals.supportedPhrases)
    .map((term) => ({ term, score: scoreSignalAgainstText(term, text) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.term.length - b.term.length)
    .map((item) => item.term)
    .slice(0, limit);
}

function projectMentionScore(entry, roleSignals) {
  const reportText = roleSignals.reportText;
  if (hasExactSignalTerm(entry.title, reportText)) return 80;
  const titleTokens = meaningfulTokens(entry.title);
  const reportTokens = tokenSet(reportText);
  const titleMatches = titleTokens.filter((token) => reportTokens.has(token)).length;
  const titleScore = titleTokens.length ? (titleMatches / titleTokens.length) * 35 : 0;
  const partialTitleScore = titleMatches >= 2 ? 120 : 0;
  const descScore = entry.description && hasExactSignalTerm(entry.description, reportText) ? 25 : 0;
  return Math.max(titleScore, partialTitleScore) + descScore;
}

function projectRelevanceScore(entry, roleSignals) {
  const text = projectSearchText(entry);
  const phraseScore = roleSignals.supportedPhrases
    .reduce((score, phrase) => score + scoreSignalAgainstText(phrase, text), 0);
  const tokenScore = [...roleSignals.tokens]
    .filter((token) => tokenSet(text).has(token))
    .length;
  const metricScore = (text.match(/\b\d+(?:\.\d+)?\s*(?:%|ms|K\+?|M\+?|QPS|concurrent|sessions|events|tools|records)\b/gi) || []).length;
  return projectMentionScore(entry, roleSignals) + phraseScore + tokenScore + metricScore;
}

function insertLeadAdjective(text, adjective) {
  const leadArticle = /^(Built|Engineered|Architected|Designed|Implemented|Optimized) (a|an|the)\b/.exec(text);
  if (leadArticle) {
    const article = leadArticle[2] === 'the'
      ? 'the'
      : (/^[aeiou]/i.test(adjective) ? 'an' : 'a');
    return text.replace(leadArticle[0], `${leadArticle[1]} ${article} ${adjective}`);
  }
  const leadVerb = /^(Built|Engineered|Architected|Designed|Implemented|Optimized)\b/.exec(text);
  if (leadVerb) {
    return text.replace(leadVerb[0], `${leadVerb[1]} ${adjective}`);
  }
  return text;
}

function tailorProjectBullet(bullet, entry, roleSignals) {
  let text = bullet;
  const roleText = roleSignals.reportText;

  if (/full-stack|end-to-end/i.test(roleText)
    && /frontend|React|Next\.js|UI/i.test(text)
    && /backend|NestJS|Spring Boot|Node\.js|PostgreSQL|Redis|RabbitMQ/i.test(text)
    && /^(Built|Engineered|Architected|Designed)\b/.test(text)
    && !/full-stack|end-to-end/i.test(text)) {
    text = insertLeadAdjective(text, 'full-stack');
  }

  if (/reliable backend|production reliability|scale|scalable/i.test(roleText)
    && /Redis|RabbitMQ|PostgreSQL|Prometheus|telemetry|audit|latency|QPS|concurrent/i.test(text)
    && !/reliable|scalable|production/i.test(text)) {
    text = insertLeadAdjective(text, 'production-grade');
  }

  return text;
}

function tailorProjectEntries(entries, roleSignals) {
  return entries
    .map((entry, index) => {
      const bulletScores = entry.bullets
        .map((bullet, bulletIndex) => ({
          bullet: tailorProjectBullet(bullet, entry, roleSignals),
          score: scoreBullet(bullet, roleSignals),
          bulletIndex,
        }))
        .sort((a, b) => b.score - a.score || a.bulletIndex - b.bulletIndex)
        .slice(0, 4)
        .map((item) => item.bullet);
      return {
        ...entry,
        sourceIndex: index,
        relevanceScore: projectRelevanceScore(entry, roleSignals),
        matchedTerms: matchedProjectTerms(entry, roleSignals),
        bullets: bulletScores,
      };
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore || a.sourceIndex - b.sourceIndex)
    .slice(0, 4);
}

function parseCvContact(cvMarkdown) {
  return {
    name: stripMarkdown((cvMarkdown.match(/^#\s+(.+)$/m) || [])[1] || 'Hongxi Chen'),
    email: stripMarkdown((cvMarkdown.match(/\*\*Email:\*\*\s*(.+)/) || [])[1] || ''),
    phone: stripMarkdown((cvMarkdown.match(/\*\*Mobile:\*\*\s*(.+)/) || [])[1] || ''),
    github: stripMarkdown((cvMarkdown.match(/\*\*GitHub:\*\*\s*(.+)/) || [])[1] || ''),
  };
}

function renderExperience(entries) {
  return entries.map((entry) => `
    <div class="job avoid-break">
      <div class="job-header">
        <div class="job-company">${escapeHtml(entry.company)}</div>
        <div class="job-period">${escapeHtml(entry.period)}</div>
      </div>
      <div class="job-role">${escapeHtml(entry.role)} <span class="job-location">${escapeHtml(entry.location)}</span></div>
      <ul>
        ${entry.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('\n')}
      </ul>
    </div>
  `).join('\n');
}

function renderProjects(entries) {
  return entries.map((entry) => `
    <div class="project avoid-break">
      <div class="project-header">
        <div class="project-title">${escapeHtml(entry.title)}</div>
        ${entry.period ? `<div class="project-badge">${escapeHtml(entry.period)}</div>` : ''}
      </div>
      ${entry.description ? `<div class="project-desc">${escapeHtml(entry.description)}</div>` : ''}
      ${entry.tech ? `<div class="project-tech"><span>Tech Stack:</span> ${escapeHtml(entry.tech)}</div>` : ''}
      ${entry.matchedTerms?.length ? `<div class="project-focus"><span>Relevant Focus:</span> ${entry.matchedTerms.map(escapeHtml).join(', ')}</div>` : ''}
      <ul>
        ${entry.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('\n')}
      </ul>
    </div>
  `).join('\n');
}

function renderSkills(entries, roleSignals) {
  return entries.map((entry) => {
    const skills = splitKeywordLine(entry.skills)
      .map((skill, index) => ({
        skill,
        index,
        score: Math.max(
          scoreSignalAgainstText(skill, roleSignals.jobText),
          [...roleSignals.tokens].some((token) => tokenSet(skill).has(token)) ? 1 : 0,
        ),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.skill);
    return `
      <div class="skill-item"><span class="skill-category">${escapeHtml(entry.category)}:</span> ${escapeHtml(skills.join(', '))}</div>
    `;
  }).join('\n');
}

function renderCertifications(entries) {
  if (!entries.length) return '';
  return `
    <div class="section avoid-break">
      <div class="section-title">Certifications</div>
      ${entries.map((entry) => `
        <div class="cert-item">
          <div class="cert-title">${escapeHtml(entry.title || entry)}</div>
          ${entry.year ? `<div class="cert-year">${escapeHtml(entry.year)}</div>` : ''}
        </div>
      `).join('\n')}
      </div>
    `;
}

function renderEducation(entries) {
  return entries.map((entry) => `
    <div class="edu-item avoid-break">
      <div class="edu-header">
        <div class="edu-title">${escapeHtml(entry.degree)}</div>
        <div class="edu-year">${escapeHtml(entry.period)}</div>
      </div>
      <div class="edu-org">${escapeHtml(entry.school)}</div>
      <div class="edu-desc">${escapeHtml(entry.location)}</div>
    </div>
  `).join('\n');
}

function replaceTemplate(template, replacements) {
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(`{{${key}}}`).join(value ?? '');
  }
  const leftover = out.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`unreplaced CV template placeholders: ${leftover.join(', ')}`);
  }
  return out;
}

function buildCvSummary(row, reportContent, roleSignals) {
  const sectionA = extractReportSection(reportContent, 'A');
  const domain = extractTableValue(sectionA, ['Domain', 'Function', 'TL;DR', 'Arquetipo detectado']);
  const summary = firstUsefulSentence(sectionA);
  const tailoring = firstUsefulSentence(extractReportSection(reportContent, 'E'));
  const target = `${row.role} at ${row.company}`;
  const roleSkills = roleSignals.supportedPhrases
    .filter((term) => term.length <= 45)
    .slice(0, 5)
    .join(', ');
  return clipText([
    `Early-career software engineer targeting ${target}${roleSkills ? ` with project evidence in ${roleSkills}` : ''}.`,
    domain || summary || 'Strong fit across full-stack software engineering, applied AI systems, backend reliability, and product-focused delivery.',
    tailoring || 'Generated CV emphasizes shipped systems, quantified impact, and the closest match between the role requirements and existing CV evidence.',
  ].join(' '), 850);
}

async function buildCvHtml(row, cvMarkdown, reportContent, profile) {
  const template = await readText('templates/cv-template.html');
  const contact = parseCvContact(cvMarkdown);
  const candidate = profile.candidate || {};
  const portfolio = candidate.portfolio_url || contact.github || candidate.github || '';
  const linkedin = candidate.linkedin || '';
  const roleSignals = buildRoleSignals(row, reportContent, cvMarkdown);
  const keySkills = extractKeySkills(reportContent, cvMarkdown, roleSignals);
  const projects = tailorProjectEntries(parseProjectEntries(cvMarkdown), roleSignals);

  return replaceTemplate(template, {
    LANG: 'en',
    PAGE_WIDTH: '8.5in',
    NAME: escapeHtml(candidate.full_name || contact.name),
    PHONE: escapeHtml(candidate.phone || contact.phone),
    EMAIL: escapeHtml(candidate.email || contact.email),
    LINKEDIN_URL: escapeHtml(normalizeUrl(linkedin)),
    LINKEDIN_DISPLAY: escapeHtml(displayUrl(linkedin)),
    PORTFOLIO_URL: escapeHtml(normalizeUrl(portfolio)),
    PORTFOLIO_DISPLAY: escapeHtml(displayUrl(portfolio)),
    LOCATION: escapeHtml(candidate.location || profile.location?.city || ''),
    SECTION_SUMMARY: 'Professional Summary',
    SUMMARY_TEXT: escapeHtml(buildCvSummary(row, reportContent, roleSignals)),
    SECTION_COMPETENCIES: 'Technical Skills',
    COMPETENCIES: keySkills
      .map((skill) => `<span class="competency-tag">${escapeHtml(skill)}</span>`)
      .join('\n'),
    SECTION_EXPERIENCE: 'Work Experience',
    EXPERIENCE: renderExperience(parseWorkEntries(cvMarkdown)),
    SECTION_PROJECTS: 'Projects',
    PROJECTS: renderProjects(projects),
    SECTION_EDUCATION: 'Education',
    EDUCATION: renderEducation(parseEducationEntries(cvMarkdown)),
    CERTIFICATIONS_SECTION: renderCertifications([]),
    SKILLS: renderSkills(parseSkillEntries(cvMarkdown), roleSignals),
  });
}

function buildCoverLetterContent(row, cvMarkdown, reportContent, profile) {
  const contact = parseCvContact(cvMarkdown);
  const candidate = profile.candidate || {};
  const linkedin = candidate.linkedin || '';
  const date = dateStamp();
  const summary = firstUsefulSentence(extractReportSection(reportContent, 'A'));
  const tailoring = firstUsefulSentence(extractReportSection(reportContent, 'E'));
  const evidence = evidenceItemsFromReport(reportContent);
  const evidenceText = evidence.length
    ? evidence.map((item) => `${item.requirement}: ${item.evidence}`).join('; ')
    : (row.notes || 'the role matches my applied software engineering and AI systems background');

  return {
    lang: 'en',
    page_width: '8.5in',
    format: 'letter',
    candidate: {
      name: candidate.full_name || contact.name,
      email: candidate.email || contact.email,
      linkedin_url: normalizeUrl(linkedin || contact.github),
      linkedin_display: displayUrl(linkedin || contact.github),
      location: candidate.location || profile.location?.city || '',
    },
    letter: {
      company: row.company,
      role: row.role,
      date,
      salutation: `Dear ${row.company} hiring team,`,
      closing: 'Best,',
      paragraphs: [
        `I am applying for the ${row.role} role at ${row.company}. ${summary || 'The role is a strong match for my software engineering, AI systems, and product-focused project background.'}`,
        `The strongest evidence I would bring into this application is ${clipText(evidenceText, 780)}`,
        tailoring || 'I would tailor this application around shipped systems, measurable technical impact, and the closest match between the job description and my CV evidence.',
        `I would welcome the chance to discuss how my background in full-stack systems, applied AI workflows, and reliable backend engineering can help ${row.company} ship useful software.`,
      ],
    },
  };
}

function runNodeScript(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `${args[0]} failed with status ${result.status}`);
  }
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

async function generateDocument(input) {
  const type = input.type;
  if (type !== 'cv' && type !== 'cover-letter') {
    throw new ClientError('type must be cv or cover-letter');
  }
  const row = {
    company: stripMarkdown(input.company),
    role: stripMarkdown(input.role),
    score: stripMarkdown(input.score),
    notes: stripMarkdown(input.notes),
    jobUrl: stripMarkdown(input.jobUrl),
    reportPath: input.reportPath,
  };
  if (!row.company || !row.role) {
    throw new ClientError('company and role are required');
  }

  const reportAbs = resolveReportPath(row.reportPath);
  const reportContent = reportAbs ? await readFile(reportAbs, 'utf8') : '';
  const cvMarkdown = await readText('cv.md');
  if (!cvMarkdown.trim()) {
    throw new ClientError('cv.md is required for PDF generation', 422);
  }

  const profile = await loadProfile();
  await mkdir(WORK_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const filename = `${type}-${slugify(row.company, 'company')}-${slugify(row.role, 'role')}-${dateStamp()}.pdf`;
  const outputPath = join(OUTPUT_DIR, filename);
  const docId = createHash('sha256')
    .update(`${type}:${row.company}:${row.role}:${row.reportPath || ''}:${Date.now()}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 20);

  if (type === 'cv') {
    const html = await buildCvHtml(row, cvMarkdown, reportContent, profile);
    const htmlPath = join(WORK_DIR, `${docId}.html`);
    await writeFile(htmlPath, html);
    runNodeScript(['generate-pdf.mjs', htmlPath, outputPath, '--format=letter']);
  } else {
    const content = buildCoverLetterContent(row, cvMarkdown, reportContent, profile);
    const jsonPath = join(WORK_DIR, `${docId}.json`);
    await writeFile(jsonPath, JSON.stringify(content, null, 2));
    runNodeScript(['generate-cover-letter.mjs', jsonPath, outputPath, '--format=letter']);
  }

  await stat(outputPath);
  const doc = { id: docId, type, filename, outputPath };
  docStore.set(docId, doc);
  return doc;
}

async function uniqueDownloadPath(filename) {
  await mkdir(DOWNLOADS_DIR, { recursive: true });
  const ext = extname(filename);
  const base = basename(filename, ext);
  let candidate = join(DOWNLOADS_DIR, filename);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(DOWNLOADS_DIR, `${base}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

async function copyToDownloads(docId) {
  const doc = docStore.get(docId);
  if (!doc) {
    throw new ClientError('document id not found or expired', 404);
  }
  await stat(doc.outputPath);
  const savedPath = await uniqueDownloadPath(doc.filename);
  await copyFile(doc.outputPath, savedPath);
  return { ...doc, savedPath };
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': `content-type,${AUTH_HEADER}`,
    });
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const { html } = renderDashboardHtml({
        extraHead: `<script>window.PDF_API_TOKEN=${JSON.stringify(API_TOKEN)};</script>`,
      });
      sendText(res, 200, 'text/html; charset=utf-8', html);
      return;
    }

    if (req.method === 'GET' && /^\/reports\/\d{3}-.+\.md$/.test(url.pathname)) {
      const filename = basename(url.pathname);
      const reportsDir = resolve(ROOT, 'reports');
      const abs = resolve(reportsDir, filename);
      if (!abs.startsWith(`${reportsDir}${sep}`) || !existsSync(abs)) {
        sendJson(res, 404, { ok: false, error: 'report not found' });
        return;
      }
      const markdown = await readFile(abs, 'utf8');
      sendText(res, 200, 'text/markdown; charset=utf-8', markdown);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, downloadsDir: DOWNLOADS_DIR });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/apply-docs/generate') {
      assertApiToken(req);
      const body = await readJsonBody(req);
      const doc = await generateDocument(body);
      sendJson(res, 200, { ok: true, doc });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/apply-docs/download') {
      assertApiToken(req);
      const body = await readJsonBody(req);
      if (!body.id) throw new ClientError('id is required');
      const doc = await copyToDownloads(String(body.id));
      sendJson(res, 200, { ok: true, doc });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    const status = error instanceof ClientError ? error.status : 500;
    sendJson(res, status, {
      ok: false,
      error: error.message || 'internal error',
    });
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] serving at http://${HOST}:${PORT}/`);
  console.log(`[dashboard] downloads directory: ${DOWNLOADS_DIR}`);
});
