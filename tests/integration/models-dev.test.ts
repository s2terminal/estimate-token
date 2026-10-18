import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog, loadModelMappings } from "../../pipeline/config.ts";
import { mergeModels } from "../../pipeline/merge-models.ts";
import { normalizeModelsDev, validateCatalog } from "../../pipeline/models-dev.ts";
import { applyRecommendations } from "../../pipeline/recommend.ts";
import type { PriceData, PriceRule } from "../../shared/types.ts";

const raw = readFileSync(new URL("../fixtures/models-dev.catalog.json", import.meta.url), "utf8");
const meta = JSON.parse(readFileSync(new URL("../fixtures/models-dev.meta.json", import.meta.url), "utf8"));
const data = normalizeModelsDev(validateCatalog(JSON.parse(raw)));
const published: PriceData = JSON.parse(readFileSync(new URL("../../public/data/latest.json", import.meta.url), "utf8"));
const rulesOnly = (rules: PriceRule[]) => rules.map(({ provenance, comparedSources, ...r }) => r);
const catalog = loadCatalog(), mappings = loadModelMappings();

describe("2026-10-18のライブcatalog固定fixture", () => {
  it("抽出fixtureの内容ハッシュと元スナップショットの出典を保持する", () => {
    expect(meta.url).toBe("https://models.dev/catalog.json");
    expect(meta.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.fixtureSha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(meta.bytes).toBeGreaterThan(Buffer.byteLength(raw));
  });
  it("現在のおすすめ15件に共通メタデータのリリース日を補完し、既存IDと既存料金を維持する", () => {
    const models = structuredClone(published.models);
    // 毎日の公開JSONの変更から独立して、fixture採用時のモデルを固定する。
    const ids = [
      "claude-haiku-5-5@anthropic:global", "claude-opus-5-5@anthropic:global", "claude-sonnet-5-5@anthropic:global",
      "gemini-3-pro-image@gemini-api:global", "gemini-3.1-flash-image@gemini-api:global", "gemini-3.1-flash-lite-image@gemini-api:global",
      "gemini-3.1-pro-preview@gemini-api:global", "gemini-3.5-flash-lite@gemini-api:global", "gemini-3.8-flash@gemini-api:global",
      "gemini-nano-banana-2.1@gemini-api:global", "gpt-6-astra@openai:global", "gpt-6-luna@openai:global", "gpt-6.1-sol@openai:global",
      "gpt-image-2.5-flare@openai:global", "gpt-image-2.5-sunburst@openai:global",
    ];
    for (const m of models) { delete m.releaseDate; delete m.releaseDateSource; }
    mergeModels(models, data, mappings, catalog, "2026-10-18");
    for (const id of ids) {
      const m = models.find(m => m.id === id)!;
      expect(m.releaseDate).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(m.releaseDateSource?.source).toBe("models.dev");
      expect(rulesOnly(m.prices)).toEqual(rulesOnly(published.models.find(p => p.id === id)!.prices));
    }
    expect(models.find(m => m.id === "gpt-6.1-sol@openai:global")?.releaseDate).toBe("2026-09-29");
    expect(models.find(m => m.id === "gemini-nano-banana-2.1@gemini-api:global")?.releaseDate).toBe("2026-10-06");
    applyRecommendations(models, catalog.recommendations, "2026-10-18");
    const featured = models.filter(m => m.featured);
    expect(new Set(featured.map(m => m.canonicalModelId ?? m.family)).size).toBe(featured.length);
    expect(models.map(m => m.id)).toEqual(published.models.map(m => m.id));
  });
  it("配信済みの272K価格を補完し、LiteLLMにない確認済みモデルも価格ソースとして採用できる", () => {
    const m = structuredClone(published.models.find(m => m.id === "gpt-6.1-sol@openai:global")!);
    m.prices = m.prices.filter(r => r.tier !== "standard" || r.minPromptTokens === 0);
    const base = m.prices.find(r => r.tier === "standard")!;
    delete base.cacheRead; delete base.provenance?.cacheRead;
    mergeModels([m], data, mappings, catalog, "2026-10-18");
    expect(base.cacheRead).toBe(0.1);
    expect(m.prices.find(r => r.tier === "standard" && r.minPromptTokens === 0)?.provenance?.cacheRead?.source).toBe("models.dev");
    expect(m.prices.find(r => r.tier === "standard" && r.minPromptTokens === 272000)).toMatchObject({ input: 4, output: 15 });
    const added = mergeModels([], data, mappings, catalog, "2026-10-18").models;
    expect(added.some(m => m.id === "gpt-6.1-sol@openai:global")).toBe(true);
    expect(added.some(m => m.id.includes("spark"))).toBe(false);
  });
});
