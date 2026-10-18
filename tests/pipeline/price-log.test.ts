import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../pipeline/config.ts";
import { normalize } from "../../pipeline/normalize.ts";
import { select, type LiteLLMData } from "../../pipeline/select.ts";

// Issue #3 (2026-10-13) の未解析キーと比較用の既存キー。
// LiteLLM a86ad9ebf82a8ba8f58fa765f61bf38ee231d4f5 の必要な項目だけを保持。
const raw: LiteLLMData = JSON.parse(readFileSync(new URL("../fixtures/price-log-sample.json", import.meta.url), "utf8"));
const catalog = loadCatalog();
const selected = select(raw, catalog, "2026-10-13");
const { models, unparsed } = normalize(selected, catalog);

describe("価格更新ログの未解析キー", () => {
  it("画像サイズ・ステップ別料金とツール料金を選別し、残りは解析できる", () => {
    const keys = selected.map(([key]) => key);
    expect(keys).not.toContain("max-x-max/50-steps/stability.stable-diffusion-xl-v0");
    expect(keys).not.toContain("max-x-max/max-steps/stability.stable-diffusion-xl-v0");
    expect(keys).not.toContain("openai/container");
    expect(selected).toHaveLength(Object.keys(raw).length - 3);
    expect(unparsed).toEqual([]);
  });

  it("Azure Global Standard は通常の global と分離し、日付別名だけを統合する", () => {
    const gpt4o = models.filter((m) => m.family === "gpt-4o");
    expect(gpt4o.map((m) => m.region).sort()).toEqual(["global", "global-standard"]);
    const standard = gpt4o.find((m) => m.region === "global-standard")!;
    expect(standard.prices).toContainEqual(expect.objectContaining({ tier: "batch", minPromptTokens: 0, input: 1.25, output: 5 }));
    expect(standard.sources[0].aliases).toEqual(["azure/global-standard/gpt-4o-2024-11-20"]);
    expect(models.some((m) => m.id === "gpt-4o-mini@azure:global-standard")).toBe(true);
  });

  it("Azure のデプロイ種別が違う料金を混ぜない", () => {
    const entry = { litellm_provider: "azure", mode: "chat", input_cost_per_token: 0.000005, output_cost_per_token: 0.000015 };
    const result = normalize([
      ["azure/gpt-4o", entry],
      ["azure/global-standard/gpt-4o", { ...entry, input_cost_per_token: 0.0000025 }],
    ], catalog);
    expect(result.models.find((m) => m.region === "global")?.prices[0].input).toBe(5);
    expect(result.models.find((m) => m.region === "global-standard")?.prices[0].input).toBe(2.5);
  });

  it.each([
    "gemini-2.0-flash-exp-image-generation", "gemini-flash-latest", "gemini-flash-lite-latest",
    "gemini-pro-latest", "gemini-exp-1206",
  ])("%s の接頭辞あり・なしを重複表示しない", (family) => {
    const matches = models.filter((m) => m.family === family);
    expect(matches).toHaveLength(1);
    const sources = matches[0].sources[0];
    expect([sources.litellm, ...(sources.aliases ?? [])]).toEqual(expect.arrayContaining([family, `gemini/${family}`]));
  });

  it("Bedrock Invoke の経路を同一モデルの別名として扱う", () => {
    const matches = models.filter((m) => m.family === "claude-3-5-sonnet");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ region: "regional", vendor: "Anthropic" });
    expect(matches[0].sources[0].aliases).toContain("bedrock/invoke/anthropic.claude-3-5-sonnet-20240620-v1:0");
  });
});
