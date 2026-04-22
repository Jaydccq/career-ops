import { describe, expect, test } from "vitest";

import {
  buildLinkedInSearchPageUrls,
  canonicalLinkedInJobViewUrl,
  detectLinkedInAuthBlock,
  extractLinkedInJobId,
  isLinkedInJobsUrl,
  normalizeLinkedInPostedAgo,
  parseLinkedInWorkModel,
} from "./linkedin-scan-normalizer.js";

describe("linkedin-scan-normalizer", () => {
  test("extracts job ids from LinkedIn job view and search-result URLs", () => {
    expect(extractLinkedInJobId("https://www.linkedin.com/jobs/view/4347121472/")).toBe("4347121472");
    expect(extractLinkedInJobId("https://www.linkedin.com/jobs/search-results/?currentJobId=4404203123&f_TPR=r86400")).toBe("4404203123");
    expect(extractLinkedInJobId("/jobs/view/111222333/?refId=abc")).toBe("111222333");
  });

  test("canonicalizes LinkedIn job URLs to job-view pages", () => {
    expect(
      canonicalLinkedInJobViewUrl("https://www.linkedin.com/jobs/search-results/?currentJobId=4347121472&f_TPR=r86400"),
    ).toBe("https://www.linkedin.com/jobs/view/4347121472/");
    expect(canonicalLinkedInJobViewUrl("https://www.linkedin.com/company/openai/")).toBeNull();
  });

  test("identifies only LinkedIn job URLs", () => {
    expect(isLinkedInJobsUrl("https://www.linkedin.com/jobs/view/4347121472/")).toBe(true);
    expect(isLinkedInJobsUrl("https://linkedin.com/jobs/search-results/?currentJobId=4347121472")).toBe(true);
    expect(isLinkedInJobsUrl("https://www.linkedin.com/in/williamhgates")).toBe(false);
  });

  test("builds safe LinkedIn search page URLs with start offsets", () => {
    expect(
      buildLinkedInSearchPageUrls(
        "https://www.linkedin.com/jobs/search-results/?currentJobId=4347121472&keywords=software&f_TPR=r86400",
        3,
        25,
      ),
    ).toEqual([
      "https://www.linkedin.com/jobs/search-results/?currentJobId=4347121472&keywords=software&f_TPR=r86400",
      "https://www.linkedin.com/jobs/search-results/?keywords=software&f_TPR=r86400&start=25",
      "https://www.linkedin.com/jobs/search-results/?keywords=software&f_TPR=r86400&start=50",
    ]);
  });

  test("normalizes reposted LinkedIn age strings", () => {
    expect(normalizeLinkedInPostedAgo("Reposted 2 hours ago")).toBe("2 hours ago");
    expect(normalizeLinkedInPostedAgo("Posted an hour ago")).toBe("1 hour ago");
    expect(normalizeLinkedInPostedAgo("Just now")).toBe("today");
    expect(normalizeLinkedInPostedAgo("Actively recruiting")).toBe("unknown");
  });

  test("parses LinkedIn work model text", () => {
    expect(parseLinkedInWorkModel("United States (Remote)")).toBe("Remote");
    expect(parseLinkedInWorkModel("San Francisco, CA (Hybrid)")).toBe("Hybrid");
    expect(parseLinkedInWorkModel("Austin, TX (On-site)")).toBe("On-site");
    expect(parseLinkedInWorkModel("New York, NY")).toBe("");
  });

  test("detects LinkedIn login and checkpoint states", () => {
    expect(detectLinkedInAuthBlock({
      url: "https://www.linkedin.com/login",
      title: "LinkedIn Login, Sign in",
      text: "Sign in to view jobs",
    })).toBe("login");
    expect(detectLinkedInAuthBlock({
      url: "https://www.linkedin.com/checkpoint/challenge",
      title: "Security Verification",
      text: "Let's do a quick security check",
    })).toBe("checkpoint");
    expect(detectLinkedInAuthBlock({
      url: "https://www.linkedin.com/jobs/search-results/?currentJobId=1",
      title: "LinkedIn Jobs",
      text: "Software Engineer jobs",
    })).toBeNull();
  });
});
