/**
 * dashboard.ts — Fastify routes that serve the dashboard HTML and reports.
 *
 * Stage 3 / commit 2 scope:
 *   • GET /dashboard/             — render dashboard HTML (no auth)
 *   • GET /dashboard/index.html   — alias for the above (no auth)
 *   • GET /reports/:filename      — read reports/{NNN-slug-YYYY-MM-DD}.md (no auth)
 *
 * The dashboard HTML carries the bridge token in a <meta> tag so the inline
 * script can read it and call /dashboard/api/* endpoints (added in commit 3)
 * with the token in the X-Career-Ops-Token header.
 *
 * The HTML rendering itself is delegated to web/build-dashboard.mjs's
 * renderDashboardHtml() — no logic duplication.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";

// @ts-expect-error — .mjs module without types; runtime resolution only.
import { renderDashboardHtml } from "../../../../web/build-dashboard.mjs";

export interface DashboardRouteOptions {
  /** Bridge auth token. Injected into the dashboard HTML via <meta> tag. */
  token: string;
  /** Repository root — used to resolve reports/<filename>.md. */
  repoRoot: string;
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
}
