import { describe, expect, test } from "vitest";

import {
  buildIndeedPageUrl,
  normalizeBuiltInAdapterRows,
  normalizeIndeedAdapterRows,
} from "./job-board-scan-normalizer.js";

describe("job-board-scan-normalizer", () => {
  test("normalizes Built In adapter rows into NewGradRow shape", () => {
    const rows = normalizeBuiltInAdapterRows([
      {
        position: 1,
        id: "9119371",
        title: "Software Developer",
        company: "BAE Systems, Inc.",
        location: "Mount Laurel, NJ, USA",
        workModel: "Hybrid",
        salary: "79K-135K Annually",
        seniority: "Junior",
        postedAgo: "49 Minutes Ago",
        summary: "Develop software solutions and data pipelines.",
        url: "https://builtin.com/job/software-developer/9119371",
      },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        source: "builtin.com",
        position: 1,
        title: "Software Developer",
        company: "BAE Systems, Inc.",
        location: "Mount Laurel, NJ, USA",
        workModel: "Hybrid",
        salary: "79K-135K Annually",
        postedAgo: "49 Minutes Ago",
        detailUrl: "https://builtin.com/job/software-developer/9119371",
        applyUrl: "https://builtin.com/job/software-developer/9119371",
        qualifications: expect.stringContaining("Develop software solutions"),
      }),
    ]);
  });

  test("normalizes Indeed adapter rows into NewGradRow shape", () => {
    const rows = normalizeIndeedAdapterRows([
      {
        position: 1,
        id: "abc123",
        title: "Software Engineer I",
        company: "Uber",
        location: "Remote in San Francisco, CA",
        salary: "$150,000 - $166,000 a year",
        attributes: ["Full-time"],
        postedAgo: "New",
        snippet: "Build backend services.",
        url: "https://www.indeed.com/viewjob?jk=abc123",
      },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        source: "indeed.com",
        position: 1,
        title: "Software Engineer I",
        company: "Uber",
        location: "Remote in San Francisco, CA",
        workModel: "Remote",
        salary: "$150,000 - $166,000 a year",
        postedAgo: "New",
        detailUrl: "https://www.indeed.com/viewjob?jk=abc123",
        applyUrl: "https://www.indeed.com/viewjob?jk=abc123",
        qualifications: expect.stringContaining("Build backend services"),
      }),
    ]);
  });

  test("preserves full Indeed URL filters while paging", () => {
    const url = buildIndeedPageUrl(
      "https://www.indeed.com/jobs?q=software%20engineer%2C%20AI%20engineer&l=&fromage=7&sc=0kf%3Aattr%28CF3CP%29explvl%28ENTRY_LEVEL%29%3B&from=searchOnDesktopSerp",
      3,
    );

    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toBe("software engineer, AI engineer");
    expect(parsed.searchParams.get("l")).toBe("");
    expect(parsed.searchParams.get("fromage")).toBe("7");
    expect(parsed.searchParams.get("sc")).toBe("0kf:attr(CF3CP)explvl(ENTRY_LEVEL);");
    expect(parsed.searchParams.get("from")).toBe("searchOnDesktopSerp");
    expect(parsed.searchParams.get("start")).toBe("20");
  });
});
