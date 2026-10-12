import { describe, expect, it } from "vitest";
import { loadCatalog } from "../pipeline/config.ts";
import { crossCheck } from "../pipeline/crosscheck.ts";
import { buildRules, displayName, normalize, parseKey, perMillion } from "../pipeline/normalize.ts";
import { select } from "../pipeline/select.ts";
import { TODAY, litellmSample, openrouterSample } from "./helpers.ts";

const catalog = loadCatalog();
const run = () => normalize(select(litellmSample(), catalog, TODAY), catalog);
const find = (id: string) => run().models.find((m) => m.id === id);

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

describe("parseKey", () => {
  it.each([
    ["gpt-6.1-sol", "openai", "gpt-6.1-sol", "global"],
    ["claude-sonnet-5-5", "anthropic", "claude-sonnet-5-5", "global"],
    ["gemini/gemini-3.7-flash", "gemini-api", "gemini-3.7-flash", "global"],
    ["vertex_ai/gemini-3.7-flash", "vertex-ai", "gemini-3.7-flash", "global"],
    ["gemini-3.7-flash", "vertex-ai", "gemini-3.7-flash", "global"],
    ["vertex_ai/claude-opus-5-5@default", "vertex-ai", "claude-opus-5-5", "global"],
    ["jp.anthropic.claude-sonnet-5", "bedrock", "claude-sonnet-5", "jp"],
    ["anthropic.claude-sonnet-5", "bedrock", "claude-sonnet-5", "regional"],
    ["bedrock/us-gov-west-1/anthropic.claude-sonnet-5", "bedrock", "claude-sonnet-5", "us-gov-west-1"],
    ["azure/gpt-6.1-sol", "azure", "gpt-6.1-sol", "global"],
    ["azure/us/gpt-6.1-sol", "azure", "gpt-6.1-sol", "us"],
  ] as const)("%s → %s / %s", (key, platform, family, region) => {
    expect(parseKey(key, platform)).toMatchObject({ family, region });
  });

  it("日付付きの別名を見分ける", () => {
    expect(parseKey("azure/gpt-6.1-sol-2026-09-29", "azure")).toMatchObject({ family: "gpt-6.1-sol", dated: true });
  });

  it("解析できない形は null", () => {
    expect(parseKey("gemini-3.7-flash", "gemini-api")).toBeNull();
    expect(parseKey("azure/global-standard/gpt-4o", "azure")).toBeNull();
  });
});

describe("normalize", () => {
  it("gpt-6.1-sol: standard 2/10、272K超 4/15、batch 1/5", () => {
    const m = find("gpt-6.1-sol@openai:global")!;
    expect(m).toMatchObject({ name: "GPT-6.1 Sol", vendor: "OpenAI", category: "llm", contextWindow: 922000 });
    const rule = (tier: string, min: number) => m.prices.find((r) => r.tier === tier && r.minPromptTokens === min);
    expect(rule("standard", 0)).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(rule("standard", 272000)).toMatchObject({ input: 4, output: 15 });
    expect(rule("batch", 0)).toMatchObject({ input: 1, output: 5 });
  });

  it("リージョンで単価が違うものは別行になる", () => {
    expect(find("claude-sonnet-5@bedrock:regional")!.prices[0].input).toBe(2);
    expect(find("claude-sonnet-5@bedrock:jp")!.prices[0].input).toBe(2.2);
    expect(find("gpt-6.1-sol@azure:us")!.prices[0].input).toBe(2.2);
  });

  it("日付付きの別名と重複エントリを1行にまとめる", () => {
    const ids = run().models.map((m) => m.id);
    expect(ids.filter((id) => id === "gpt-6.1-sol@azure:global")).toHaveLength(1);
    expect(find("gpt-6.1-sol@azure:global")!.sources[0]).toMatchObject({ litellm: "azure/gpt-6.1-sol", aliases: ["azure/gpt-6.1-sol-2026-09-29"] });
    // vertex: 接頭辞なし・あり、@default がまとまる
    expect(ids.filter((id) => id.startsWith("gemini-3.7-flash@vertex-ai"))).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith("claude-opus-5-5@vertex-ai"))).toHaveLength(1);
    // azure と azure_ai の同名は azure を優先
    expect(find("gpt-6-astra@azure:global")!.sources[0].litellm).toBe("azure/gpt-6-astra");
  });

  it("画像の1枚単価と画像出力トークン単価を保持する", () => {
    expect(find("gemini-3.1-flash-image@gemini-api:global")!.prices).toEqual([{ tier: "standard", minPromptTokens: 0, perImage: 0.045, imageOutput: 60 }]);
    expect(find("gemini-3.1-flash-image@vertex-ai:global")!.prices[0].perImage).toBe(0.0672);
  });

  it("画像トークン課金のOpenAIモデルを落とさず、日付付き別名も統合する", () => {
    const m = find("gpt-image-2@openai:global")!;
    expect(m.category).toBe("image");
    expect(m.prices).toEqual([{ tier: "standard", minPromptTokens: 0, imageOutput: 30 }]);
    expect(m.sources[0].aliases).toContain("gpt-image-2-2026-04-21");
    expect(find("gpt-image-2.5-sunburst@openai:global")!.featured).toBe(true);
    expect(find("gpt-image-1.5@openai:global")!.prices[0].imageOutput).toBe(32);
  });

  it("featured が付く", () => {
    expect(find("claude-sonnet-5-5@anthropic:global")!.featured).toBe(true);
  });
});

describe("helpers", () => {
  it("×1,000,000 後に有効数字6桁で丸める", () => {
    expect(perMillion(2.2e-7)).toBe(0.22);
    expect(perMillion(0.0000022)).toBe(2.2);
    expect(perMillion(3.75e-8)).toBe(0.0375);
  });

  it("表示名", () => {
    expect(displayName("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(displayName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(displayName("gemini-3.7-flash")).toBe("Gemini 3.7 Flash");
    expect(displayName("claude-3-5-sonnet")).toBe("Claude 3.5 Sonnet");
    expect(displayName("x", { x: "上書き" })).toBe("上書き");
  });

  it("価格項目のない LLM はルールなし", () => {
    expect(buildRules({ mode: "chat" }, "llm")).toEqual([]);
  });
});

describe("crossCheck", () => {
  const now = new Date(`${TODAY}T00:00:00Z`);
  const check = (models = run().models) => ({ models, ...crossCheck(models, openrouterSample(), { mismatchPct: 20, recentDays: 60, now }) });

  it("差がしきい値以内なら何も付けない(OpenRouter の id や値は記録しない)", () => {
    const { models, mismatches } = check();
    expect(mismatches).toEqual([]);
    expect(models.some((m) => m.needsReview)).toBe(false);
    expect(JSON.stringify(models)).not.toContain("openrouter");
  });

  it("差が20%超なら needsReview を付け、id だけ返す", () => {
    const models = run().models;
    models.find((m) => m.id === "gpt-6.1-sol@openai:global")!.prices[0].input = 1;
    const r = check(models);
    expect(r.mismatches).toEqual(["gpt-6.1-sol@openai:global"]);
    expect(models.find((m) => m.id === "gpt-6.1-sol@openai:global")!.needsReview).toBe(true);
  });

  it("OpenRouter にだけある新しいテキストモデルを名前だけ候補にする(公開データには入れない)", () => {
    const { models, candidates } = check();
    const before = run().models.length;
    expect(candidates).toEqual([{ family: "example-new-model", platform: "openai" }]);
    expect(models).toHaveLength(before);
  });
});
