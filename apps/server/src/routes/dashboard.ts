/**
 * dashboard.ts — Fastify routes that serve the dashboard HTML, reports,
 * and the dashboard JSON API.
 *
 * Stage 3 / commit 3 scope:
 *   • GET  /dashboard/                       — render dashboard HTML (no auth)
 *   • GET  /dashboard/index.html             — alias for the above (no auth)
 *   • GET  /reports/:filename                — read reports/{NNN-slug-YYYY-MM-DD}.md (no auth)
 *   • GET  /dashboard/api/health             — health probe (auth required)
 *   • POST /dashboard/api/apply-docs/generate    (auth required)
 *   • POST /dashboard/api/apply-docs/download    (auth required)
 *   • POST /dashboard/api/apply-status           (auth required)
 *   • POST /dashboard/api/full-evaluation        (auth required, returns 202)
 *   • POST /dashboard/api/full-evaluation/status (auth required)
 *
 * The dashboard HTML carries the bridge token in a <meta> tag so the inline
 * script can read it and call /dashboard/api/* endpoints with the token in
 * the X-Career-Ops-Token header.
 *
 * The HTML rendering and API helpers are delegated to .mjs modules under
 * web/ — no logic duplication. Tests inject stubbed implementations via
 * DashboardRouteOptions to avoid spawning Playwright / hitting the bridge.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";

// @ts-expect-error — .mjs module without types; runtime resolution only.
import { renderDashboardHtml } from "../../../../web/build-dashboard.mjs";
// @ts-expect-error — .mjs module without types; runtime resolution only.
// eslint-disable-next-line import/no-unresolved
import * as dashboardServerImpl from "../../../../web/dashboard-server.mjs";

const {
  APPLICATIONS_PATH: DEFAULT_APPLICATIONS_PATH,
  DOWNLOADS_DIR: DEFAULT_DOWNLOADS_DIR,
  copyToDownloads: defaultCopyToDownloads,
  generateDocument: defaultGenerateDocument,
  queueFullEvaluation: defaultQueueFullEvaluation,
  readFullEvaluationStatus: defaultReadFullEvaluationStatus,
  setApplicationStatusForFile: defaultSetApplicationStatusForFile,
} = dashboardServerImpl as {
  APPLICATIONS_PATH: string;
  DOWNLOADS_DIR: string;
  copyToDownloads: (id: string) => Promise<unknown>;
  generateDocument: (body: unknown) => Promise<unknown>;
  queueFullEvaluation: (
    body: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  readFullEvaluationStatus: (
    body: unknown,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  setApplicationStatusForFile: (
    path: string,
    body: unknown,
  ) => Promise<{ status: string | null; changed: boolean }>;
};

export interface DashboardRouteOptions {
  /** Bridge auth token. Injected into the dashboard HTML via <meta> tag. */
  token: string;
  /** Repository root — used to resolve reports/<filename>.md. */
  repoRoot: string;
  /* ------------------------------------------------------------------ */
  /* Optional DI hooks (for tests). Production wiring leaves them unset */
  /* and the .mjs defaults take over.                                   */
  /* ------------------------------------------------------------------ */
  generateDocumentImpl?: (body: unknown) => Promise<unknown>;
  copyToDownloadsImpl?: (id: string) => Promise<unknown>;
  setApplicationStatusImpl?: (
    body: unknown,
  ) => Promise<{ status: string | null; changed: boolean }>;
  applicationsPath?: string;
  postBridgeImpl?: (
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Promise<unknown>;
  getBridgeImpl?: (
    path: string,
    headers: Record<string, string>,
  ) => Promise<unknown>;
  bridgeBase?: string;
  /** Override DOWNLOADS_DIR reported by /dashboard/api/health (tests). */
  downloadsDir?: string;
}

const REPORT_FILENAME_PATTERN = /^\d{3}-[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}\.md$/;

/**
 * Returns true when the request targets a path that is intentionally
 * exposed without auth: the dashboard HTML and read-only report markdown.
 *
 * Narrow by design: only 3 path patterns. Everything else (including
 * /dashboard/api/*) still goes through the global auth hook.
 */
export function isPublicDashboardPath(req: FastifyRequest): boolean {
  if (req.method !== "GET") return false;
  // Strip query string before matching to avoid bypass via ?foo=...
  const url = req.url ?? "";
  const path = url.split("?")[0] ?? "";
  if (path === "/dashboard/" || path === "/dashboard/index.html") return true;
  if (path.startsWith("/reports/") && path.endsWith(".md")) return true;
  return false;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function registerDashboardRoutes(
  fastify: FastifyInstance,
  options: DashboardRouteOptions,
): Promise<void> {
  const { token, repoRoot } = options;

  const renderHtml = (): string => {
    const metaTag =
      `<meta name="career-ops-token" content="${escapeHtmlAttr(token)}">`;
    const { html } = renderDashboardHtml({
      extraHead: metaTag,
      includeGmailSignals: true,
      includeProfile: true,
    }) as { html: string };
    return html;
  };

  fastify.get("/dashboard/", async (_req, reply) => {
    const html = renderHtml();
    reply.code(200).header("content-type", "text/html; charset=utf-8").send(html);
  });

  fastify.get("/dashboard/index.html", async (_req, reply) => {
    const html = renderHtml();
    reply.code(200).header("content-type", "text/html; charset=utf-8").send(html);
  });

  const reportsDir = resolve(repoRoot, "reports");

  fastify.get<{ Params: { filename: string } }>(
    "/reports/:filename",
    async (req, reply) => {
      const filename = req.params.filename;
      if (
        !filename ||
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("..") ||
        !REPORT_FILENAME_PATTERN.test(filename)
      ) {
        reply.code(404).send({ ok: false, error: "report not found" });
        return;
      }
      const abs = resolve(reportsDir, filename);
      if (!abs.startsWith(reportsDir + sep) || !existsSync(abs)) {
        reply.code(404).send({ ok: false, error: "report not found" });
        return;
      }
      const markdown = await readFile(abs, "utf8");
      reply
        .code(200)
        .header("content-type", "text/markdown; charset=utf-8")
        .send(markdown);
    },
  );

  /* -------------------------------------------------------------------- */
  /* Dashboard JSON API (auth-gated by the global preHandler hook)        */
  /* -------------------------------------------------------------------- */

  const downloadsDir = options.downloadsDir ?? DEFAULT_DOWNLOADS_DIR;
  const applicationsPath =
    options.applicationsPath ?? DEFAULT_APPLICATIONS_PATH;
  const bridgeBase = options.bridgeBase;

  const generateDocument = options.generateDocumentImpl ?? defaultGenerateDocument;
  const copyToDownloads = options.copyToDownloadsImpl ?? defaultCopyToDownloads;
  const setApplicationStatus =
    options.setApplicationStatusImpl ??
    ((body: unknown) =>
      defaultSetApplicationStatusForFile(applicationsPath, body));

  fastify.get("/dashboard/api/health", async (_req, reply) => {
    reply.code(200).send({ ok: true, downloadsDir });
  });

  fastify.post("/dashboard/api/apply-docs/generate", async (req, reply) => {
    const body = isPlainObject(req.body) ? req.body : {};
    if (!body.company || typeof body.company !== "string" || !body.company.trim()) {
      reply.code(400).send({ ok: false, error: "missing company" });
      return;
    }
    const doc = await generateDocument(body);
    reply.code(200).send({ ok: true, doc });
  });

  fastify.post("/dashboard/api/apply-docs/download", async (req, reply) => {
    const body = isPlainObject(req.body) ? req.body : {};
    if (!body.id || typeof body.id !== "string") {
      reply.code(400).send({ ok: false, error: "id is required" });
      return;
    }
    const doc = await copyToDownloads(body.id);
    reply.code(200).send({ ok: true, doc });
  });

  fastify.post("/dashboard/api/apply-status", async (req, reply) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const result = await setApplicationStatus(body);
    reply
      .code(200)
      .send({ ok: true, status: result.status, changed: result.changed });
  });

  fastify.post("/dashboard/api/full-evaluation", async (req, reply) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const opts: Record<string, unknown> = {};
    if (options.postBridgeImpl) opts.postBridge = options.postBridgeImpl;
    if (bridgeBase) opts.bridgeBase = bridgeBase;
    const result = (await defaultQueueFullEvaluation(body, opts)) as Record<
      string,
      unknown
    >;
    reply.code(202).send({ ok: true, ...result });
  });

  fastify.post("/dashboard/api/full-evaluation/status", async (req, reply) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const opts: Record<string, unknown> = {};
    if (options.getBridgeImpl) opts.getBridge = options.getBridgeImpl;
    const job = await defaultReadFullEvaluationStatus(body, opts);
    reply.code(200).send({ ok: true, job });
  });
}
