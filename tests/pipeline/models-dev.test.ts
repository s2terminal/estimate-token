import { describe, expect, it } from "vitest";
import { loadCatalog, loadModelsDevPolicy } from "../../pipeline/config.ts";
import { mergeModels, pricesEqual } from "../../pipeline/merge-models.ts";
import { normalizeModelsDev, validateCatalog } from "../../pipeline/models-dev.ts";
import { normalize } from "../../pipeline/normalize.ts";
import { applyRecommendations, releaseDate } from "../../pipeline/recommend.ts";
import { calcLlm } from "../../src/lib/calc.ts";
import { catalogOf, offering } from "../support/models-dev.ts";
import { sampleModel } from "../support/fixtures.ts";
import type { Model } from "../../shared/types.ts";

const catalog = loadCatalog(), policy = loadModelsDevPolicy(), today = "2026-10-18";
const merge = (models: Model[], providers: Parameters<typeof catalogOf>[0], common = {}) =>
  mergeModels(models, normalizeModelsDev(catalogOf(providers, common)), policy, catalog, today);
const sol = () => sampleModel("gpt-6.1-sol@openai:global");
const base = (m: Model) => m.prices.find(r => r.tier === "standard" && r.minPromptTokens === 0)!;

describe("models.devの正規化・価格補完", () => {
  it("USD/1Mのまま保持し、272Kの互換項目を二重に取り込まない", () => {
    const data = normalizeModelsDev(catalogOf({ openai: [offering("gpt-6.1-sol")] }));
    expect(data.offers[0].rules.map(r => [r.minPromptTokens, r.input, r.output])).toEqual([[0, 2, 10], [272000, 4, 15]]);
    const result = merge([sol()], { openai: [offering("gpt-6.1-sol")] }).models[0];
    for (const [tokens, input, output] of [[271999, 2, 10], [272000, 2, 10], [272001, 4, 15]]) {
      const cost = calcLlm(result, { n: 1, i: tokens, o: 1, c: false, h: 0, tier: "standard" });
      expect(cost.na).toBe(false);
      if (!cost.na) expect([cost.pin, cost.pout]).toEqual([input, output]);
    }
  });
  it("確認済みの不足項目と長文料金を補い、他ティア・1時間cacheを保持する", () => {
    const m = sol();
    delete base(m).output;
    delete base(m).provenance?.output;
    m.prices = m.prices.filter(r => r.tier !== "standard" || r.minPromptTokens === 0);
    base(m).cacheWrite1h = 4;
    m.prices.push({ tier: "flex", minPromptTokens: 0, input: 1, output: 5 }, { tier: "priority", minPromptTokens: 0, input: 4, output: 20 });
    const other = structuredClone(m.prices.filter(r => r.tier !== "standard"));
    merge([m], { openai: [offering("gpt-6.1-sol")] });
    expect(base(m).output).toBe(10);
    expect(base(m).provenance?.output?.source).toBe("models.dev");
    expect(base(m).cacheWrite1h).toBe(4);
    expect(m.prices.filter(r => r.tier !== "standard")).toEqual(other);
    expect(m.prices.find(r => r.tier === "standard" && r.minPromptTokens === 272000)).toMatchObject({ input: 4, output: 15 });
  });
  it("価格の一致でもLiteLLMの値を維持し照合元を記録する", () => {
    const m = sol();
    merge([m], { openai: [offering("gpt-6.1-sol")] });
    expect(base(m).provenance?.input?.source).toBe("litellm");
    expect(base(m).comparedSources?.input?.[0]).toMatchObject({ source: "models.dev", providerId: "openai" });
    expect(pricesEqual(0.1, 0.100000001)).toBe(true);
    expect(pricesEqual(2, 2.2)).toBe(false);
  });
  it("10%の差も全件記録し、競合時は不足料金を混ぜない", () => {
    const m = sol();
    delete base(m).output;
    delete base(m).provenance?.output;
    const result = merge([m], { openai: [offering("gpt-6.1-sol", { cost: { input: 2.2, output: 10 } })] });
    expect(base(m).input).toBe(2);
    expect(base(m).output).toBeUndefined();
    expect(result.notes.some(n => n.includes("2.2") && n.includes("既存値を維持"))).toBe(true);
  });
  it("確認済みモデルはLiteLLM未収録でも追加し、未確認Sparkは候補に留める", () => {
    const result = merge([], { openai: [offering("gpt-6.1-sol"), offering("gpt-5.3-codex-spark")] });
    expect(result.models.map(m => m.id)).toEqual(["gpt-6.1-sol@openai:global"]);
    expect(base(result.models[0]).provenance?.input?.source).toBe("models.dev");
    expect(result.notes.some(n => n.includes("spark") && n.includes("追加候補"))).toBe(true);
  });
  it("総context・入力・出力上限を別々に保持し、input欠損を総contextで埋めない", () => {
    const m = sol();
    merge([m], { openai: [offering("gpt-6.1-sol")] });
    expect([m.totalContext, m.inputLimit, m.outputLimit, m.contextWindow]).toEqual([1050000, 922000, 128000, 922000]);
    const result = merge([], { openai: [offering("gpt-6.1-sol", { limit: { context: 1050000, output: 128000 } })] });
    expect(result.models[0].inputLimit).toBeUndefined();
    expect(result.models[0].contextWindow).toBeUndefined();
  });
  it("GPT-4oのsnapshotを現行aliasの価格へ結合しない", () => {
    const { models } = normalize([["gpt-4o", { litellm_provider: "openai", mode: "chat", input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 }]], catalog);
    const result = merge(models, { openai: [
      offering("gpt-4o", { cost: { input: 2.5, output: 10 } }),
      offering("gpt-4o-2024-05-13", { cost: { input: 5, output: 15 } }),
    ] });
    expect(base(models[0]).input).toBe(2.5);
    expect(result.notes.some(n => n.includes("LiteLLM=2.5"))).toBe(false);
    expect(models[0].sources.filter(s => s.modelsDev).map(s => s.modelsDev!.modelId)).toEqual(["gpt-4o"]);
  });
  it.each([
    ["azure", ["azure", "azure-cognitive-services"], "gpt-5.6-luna"],
    ["vertex-ai", ["google-vertex", "google-vertex-anthropic"], "claude-sonnet-5-5@default"],
  ] as const)("同じ%s内のprovider競合で黙って上書きしない", (platform, providers, id) => {
    const key = platform === "azure" ? "azure/" + id : "vertex_ai/" + id;
    const { models } = normalize([[key, { litellm_provider: platform === "azure" ? "azure" : "vertex_ai", mode: "chat", input_cost_per_token: 0.000002, output_cost_per_token: 0.00001 }]], catalog);
    const result = merge(models, {
      [providers[0]]: [offering(id, { cost: { input: 2, output: 10, cache_read: 0.1 } })],
      [providers[1]]: [offering(id, { cost: { input: 2, output: 10, cache_read: 0.2 } })],
    });
    expect(base(models[0]).cacheRead).toBeUndefined();
    expect(result.notes.some(n => n.includes("models.dev内の価格競合"))).toBe(true);
    expect(models[0].sources.filter(s => s.modelsDev)).toHaveLength(2);
  });
  it("Bedrockのbare IDは地域不明として価格採用を保留する", () => {
    const { models } = normalize([["bedrock/anthropic.claude-sonnet-4-6", { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 }]], catalog);
    const result = merge(models, { "amazon-bedrock": [offering("anthropic.claude-sonnet-4-6", { cost: { input: 3.3, output: 16.5 } })] });
    expect(base(models[0]).input).toBe(3);
    expect(result.notes.some(n => n.includes("地域・サービス条件は未確認"))).toBe(true);
  });
  it("動画との混合出力や画像の汎用outputをテキスト・画像単価へ転用しない", () => {
    const m = sampleModel("gpt-image-2@openai:global");
    const before = structuredClone(m.prices);
    const data = normalizeModelsDev(catalogOf({ openai: [offering("gpt-image-2", { modalities: { input: ["text"], output: ["image"] }, cost: { input: 5, output: 60 } })],
      google: [offering("gemini-omni-flash-preview", { modalities: { input: ["text"], output: ["text", "video"] }, cost: { input: 1, output: 17.5 } })] }));
    expect(data.offers.every(o => !o.rules.length)).toBe(true);
    mergeModels([m], data, policy, catalog, today);
    expect(m.prices).toEqual(before);
    expect(merge([], { openai: [offering("gpt-image-1.5", { cost: undefined })] }).models).toEqual([]);
  });
  it("互換フィールドだけの長文境界は採用しない", () => {
    const m = sol(); delete base(m).output; delete base(m).provenance?.output;
    const result = merge([m], { openai: [offering("gpt-6.1-sol", { cost: { input: 2, output: 10, context_over_200k: { input: 4, output: 15 } } })] });
    expect(base(m).output).toBeUndefined();
    expect(result.notes.some(n => n.includes("正確な境界が不明"))).toBe(true);
  });
});

describe("日付・公開状態・API検証", () => {
  it("canonicalがない場合は完全一致した共通メタデータから日付を補い、精度を保持する", () => {
    const m = sol();
    merge([m], { openai: [] }, { "openai/gpt-6.1-sol": { id: "openai/gpt-6.1-sol", name: "Sol", release_date: "2026-09" } });
    expect(m.releaseDate).toBe("2026-09");
    expect(m.releaseDateSource).toMatchObject({ source: "models.dev", precision: "month" });
    expect(releaseDate("2026-02-30")).toBeUndefined();
  });
  it("共通メタデータのリリース日をLiteLLMの値より優先して出典を変更する", () => {
    const m = sol(); m.releaseDate = "2026-09-01";
    merge([m], { openai: [offering("gpt-6.1-sol")] });
    expect(m.releaseDate).toBe("2026-09-29");
    expect(m.releaseDateSource).toMatchObject({ source: "models.dev", modelId: "openai/gpt-6.1-sol" });
  });
  it("既定サービスティアが標準以外なら確認済みIDでも価格を補完しない", () => {
    const m = sol(); delete base(m).output; delete base(m).provenance?.output;
    merge([m], { openai: [offering("gpt-6.1-sol", { provider: { body: { service_tier: "priority" } } })] });
    expect(base(m).output).toBeUndefined();
  });
  it("テキスト入力のない提供条件や独立したreasoning単価を標準テキスト料金へ混ぜない", () => {
    for (const o of [
      offering("gpt-6.1-sol", { modalities: { input: ["image"], output: ["text"] } }),
      offering("gpt-6.1-sol", { cost: { input: 2, output: 10, reasoning: 15 } }),
    ]) {
      const m = sol(); delete base(m).output; delete base(m).provenance?.output;
      merge([m], { openai: [o] });
      expect(base(m).output).toBeUndefined();
    }
    expect(() => catalogOf({ openai: [offering("gpt-6.1-sol", { modalities: { input: ["unknown"], output: ["text"] } })] })).toThrow();
  });
  it.each(["alpha", "beta", "deprecated"] as const)("%sを未確認の新モデルとして自動採用しない", status => {
    expect(merge([], { openai: [offering("gpt-6.1-sol", { status })] }).models).toEqual([]);
  });
  it("未来日のモデルは追加もおすすめ選定もしない", () => {
    expect(merge([], { openai: [offering("gpt-6.1-sol", { release_date: "2027-01-01" })] }).models).toEqual([]);
    expect(merge([], { openai: [offering("gpt-6.1-sol")] }, {
      "openai/gpt-6.1-sol": { id: "openai/gpt-6.1-sol", name: "Sol", release_date: "2027-01-01" },
    }).models).toEqual([]);
    const m = sol(); m.releaseDate = "2027-01-01";
    applyRecommendations([m], catalog.recommendations, today);
    expect(m.featured).toBeUndefined();
  });
  it("年月の区間が重なるときはバージョン、重ならないときは日付を使う", () => {
    const older = sol(), newer = { ...sol(), id: "gpt-6.2-sol@openai:global", family: "gpt-6.2-sol" };
    older.releaseDate = "2026-09"; newer.releaseDate = "2026-09-15";
    applyRecommendations([older, newer], catalog.recommendations, today);
    expect(newer.featured).toBe(true);
    older.releaseDate = "2026-10-01";
    applyRecommendations([newer, older], catalog.recommendations, today);
    expect(older.featured).toBe(true);
  });
  it("canonicalで同じモデルの提供先違いをまとめ、既存公開IDを維持する", () => {
    const a = sol(), b = { ...sol(), id: "gpt-6.1-sol@azure:global", platform: "azure" as const };
    a.canonicalModelId = b.canonicalModelId = "openai/gpt-6.1-sol";
    applyRecommendations([a, b], catalog.recommendations, today);
    expect([a, b].filter(m => m.featured).map(m => m.id)).toEqual([a.id]);
    expect(b.id).toBe("gpt-6.1-sol@azure:global");
  });
  it.each([
    null, [], {}, { models: {}, providers: {} },
    { models: { x: { id: "x", name: "x" } }, providers: { openai: { id: "openai", models: { x: { ...offering("x"), cost: { input: -1, output: 1 } } } } } },
  ])("壊れたAPI応答を拒否する", value => expect(() => validateCatalog(value)).toThrow("models.dev"));
  it("重複した長文境界を拒否し、未対応のモード・料金を報告する", () => {
    const m = offering("gpt-6.1-sol");
    m.cost!.tiers!.push(m.cost!.tiers![0]);
    expect(() => catalogOf({ openai: [m] })).toThrow();
    const data = normalizeModelsDev(catalogOf({ openai: [offering("gpt-6.1-sol", {
      cost: { input: 2, output: 10, reasoning: 3 }, experimental: { modes: { fast: { provider: { body: { service_tier: "priority" } } } } },
    })] }));
    expect(data.notes.some(n => n.includes("cost.reasoning"))).toBe(true);
    expect(data.notes.some(n => n.includes("サービスモード fast"))).toBe(true);
  });
});
