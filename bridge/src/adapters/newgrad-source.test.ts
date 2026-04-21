import { describe, expect, test } from "vitest";

import {
  pipelineTagForSource,
  scanSourceForRow,
  sourceFromPipelineTag,
} from "./newgrad-source.js";

describe("newgrad-source", () => {
  test("defaults rows without source to newgrad-jobs.com", () => {
    expect(scanSourceForRow({})).toBe("newgrad-jobs.com");
    expect(pipelineTagForSource(scanSourceForRow({}))).toBe("newgrad-scan");
  });

  test("maps Built In source without changing existing tag behavior", () => {
    expect(pipelineTagForSource("builtin.com")).toBe("builtin-scan");
    expect(sourceFromPipelineTag("builtin-scan")).toBe("builtin.com");
  });

  test("maps LinkedIn source to linkedin-scan", () => {
    expect(pipelineTagForSource("https://www.linkedin.com/jobs/view/123/")).toBe("linkedin-scan");
    expect(pipelineTagForSource("linkedin.com")).toBe("linkedin-scan");
    expect(sourceFromPipelineTag("linkedin-scan")).toBe("linkedin.com");
  });
});
