import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../pipeline/config.ts";
import { select } from "../../pipeline/select.ts";
import { TODAY, litellmSample } from "../support/fixtures.ts";

const catalog = loadCatalog();

describe("select", () => {
  it("対象外の provider・mode・廃止済み・画質別キー・sample_spec を除く", () => {
    const keys = select(litellmSample(), catalog, TODAY).map(([k]) => k);
    expect(keys).not.toContain("sample_spec");
    expect(keys).not.toContain("deepinfra/google/gemini-3.7-flash");
    expect(keys).not.toContain("github_copilot/gpt-6.1-sol");
    expect(keys).not.toContain("amazon.nova-canvas-v1:0"); // deprecation_date 2026-09-30
    expect(keys).not.toContain("low/1024-x-1024/gpt-image-1.5");
    expect(keys).toContain("gpt-6.1-sol");
  });
});
