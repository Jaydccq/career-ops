import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../runtime/config.js";
import type {
  LivenessCheck,
  MergeReport,
  PipelineAdapter,
} from "../contracts/pipeline.js";
import { buildServer } from "../server.js";

const TOKEN = "dashboard-test-token";

function makeAdapter(): PipelineAdapter {
  return {
    async doctor() {
      return {
        ok: true,
        repo: {
          rootPath: "/tmp/career-ops-test",
          careerOpsVersion: "test",
          trackerOk: true,
          cvOk: true,
          profileOk: true,
        },
        claudeCli: { ok: true },
        node: { version: "test" },
        playwrightChromium: { ok: true },
      };
    },
    async checkLiveness(url: string): Promise<LivenessCheck> {
      return { url, status: "active", reason: "test", exitCode: 0 };
    },
    async runEvaluation() {
      throw new Error("not expected in dashboard tests");
    },
    async readReport() {
      return undefined;
    },
    async readTrackerTail() {
      return { rows: [], totalRows: 0 };
    },
    async mergeTracker(): Promise<MergeReport> {
      return { dryRun: false, added: 0, updated: 0, skipped: 0 };
    },
    async scoreNewGradRows() {
      return { promoted: [], filtered: [] };
    },
    async enrichNewGradRows() {
      return { added: 0, skipped: 0, entries: [] };
    },
    async readNewGradPendingEntries() {
      return { entries: [], total: 0 };
    },
    async readBuiltInPendingEntries() {
      return { entries: [], total: 0 };
    },
    async backfillNewGradPendingCache() {
      return { updated: 0, skipped: 0, outcomes: [] };
    },
    async readAutofillProfile() {
      return {
        generatedAt: "2026-04-26T00:00:00.000Z",
        sources: ["test"],
        warnings: [],
        fields: [],
      };
    },
    async readAutofillResume() {
      return {
        filename: "test-resume.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
        dataBase64: "dGVzdA==",
      };
    },
  };
}

function makeConfig(repoRoot: string): BridgeConfig {
  return {
    repoRoot,
    bridgeDir: join(repoRoot, "apps/server"),
    host: "127.0.0.1",
    port: 47319,
    token: TOKEN,
    claudeBin: "claude",
    codexBin: "codex",
    codexModel: "gpt-5.4-mini",
    codexReasoningEffort: "medium",
    nodeBin: "node",
    mode: "real",
    realExecutor: "codex",
    evaluationTimeoutSec: 30,
    evaluationConcurrency: 1,
    evaluationRateLimitPerMinute: 30,
    livenessTimeoutSec: 10,
    bridgeVersion: "test",
    careerOpsVersion: "test",
  };
}

describe("dashboard routes", () => {
  let tmpRepoRoot: string;
  let reportsDir: string;

  beforeEach(() => {
    tmpRepoRoot = mkdtempSync(join(tmpdir(), "career-ops-dashboard-"));
    reportsDir = join(tmpRepoRoot, "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, "001-acme-2026-04-27.md"),
      "# Acme report\n\n**URL:** https://acme.example/jobs/1\n",
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(tmpRepoRoot, { recursive: true, force: true });
  });

  it("GET /dashboard/ returns 200 HTML with the bridge token meta tag, no auth required", async () => {
    const { fastify } = buildServer({
      config: makeConfig(tmpRepoRoot),
      adapter: makeAdapter(),
    });
    try {
      const res = await fastify.inject({ method: "GET", url: "/dashboard/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain(
        `<meta name="career-ops-token" content="${TOKEN}">`,
      );
    } finally {
      await fastify.close();
    }
  });

  it("GET /dashboard/index.html returns the same HTML response", async () => {
    const { fastify } = buildServer({
      config: makeConfig(tmpRepoRoot),
      adapter: makeAdapter(),
    });
    try {
      const res = await fastify.inject({
        method: "GET",
        url: "/dashboard/index.html",
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toContain(
        `<meta name="career-ops-token" content="${TOKEN}">`,
      );
    } finally {
      await fastify.close();
    }
  });

  it("GET /dashboard/api/health (commit-3 path) is NOT in the auth allowlist — returns 401 without a token", async () => {
    const { fastify } = buildServer({
      config: makeConfig(tmpRepoRoot),
      adapter: makeAdapter(),
    });
    try {
      const res = await fastify.inject({
        method: "GET",
        url: "/dashboard/api/health",
      });
      // Allowlist must NOT cover /dashboard/api/*. Auth runs and rejects.
      expect(res.statusCode).toBe(401);
    } finally {
      await fastify.close();
    }
  });

  it("GET /reports/<existing>.md returns 200 + markdown body", async () => {
    const { fastify } = buildServer({
      config: makeConfig(tmpRepoRoot),
      adapter: makeAdapter(),
    });
    try {
      const res = await fastify.inject({
        method: "GET",
        url: "/reports/001-acme-2026-04-27.md",
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/markdown/);
      expect(res.body).toContain("# Acme report");
      expect(res.body).toContain("**URL:** https://acme.example/jobs/1");
    } finally {
      await fastify.close();
    }
  });

  it("GET /reports/<nonexistent>.md returns 404", async () => {
    const { fastify } = buildServer({
      config: makeConfig(tmpRepoRoot),
      adapter: makeAdapter(),
    });
    try {
      const res = await fastify.inject({
        method: "GET",
        url: "/reports/999-missing-2099-01-01.md",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await fastify.close();
    }
  });

  it("GET /reports/ with a path-traversal filename returns 404 (does not escape reportsDir)", async () => {
    const { fastify } = buildServer({
      config: makeConfig(tmpRepoRoot),
      adapter: makeAdapter(),
    });
    try {
      // Use a .md suffix so the auth allowlist DOES apply (path is treated
      // as a "public" reports request). The route handler must still reject
      // because the filename contains "..", "/" — never letting traversal
      // escape reportsDir even when auth has already passed.
      const res = await fastify.inject({
        method: "GET",
        url: "/reports/..%2Fetc%2Fpasswd.md",
      });
      // Either 404 (route guard rejects) or no 200 leaking /etc/passwd.
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("root:");
    } finally {
      await fastify.close();
    }
  });
});
