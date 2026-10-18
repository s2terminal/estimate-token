import { describe, expect, it } from "vitest";
import { contentHash } from "../../pipeline/content.ts";
import { diffData, diffMarkdown } from "../../pipeline/diff.ts";
import { evaluateGates, validateSchema } from "../../pipeline/validate.ts";
import { loadGates } from "../../pipeline/config.ts";
import { MODELS_DEV_URL } from "../../pipeline/models-dev.ts";
import { sampleData } from "../support/fixtures.ts";
import { sourceCell } from "../../src/lib/sources.ts";

const source = { source: "models.dev" as const, modelId: "gpt-6.1-sol", providerId: "openai", url: MODELS_DEV_URL };
function enriched() {
  const data = sampleData();
  data.sources.modelsDev = { url: MODELS_DEV_URL, sha256: "a".repeat(64), bytes: 1000, fetchedAt: "2026-10-12T00:00:00Z", counts: { openai: 20 } };
  const m = data.models.find(m => m.id === "gpt-6.1-sol@openai:global")!;
  m.releaseDate = "2026-09";
  m.releaseDateSource = { ...source, precision: "month" };
  return data;
}
describe("models.devの公開スキーマ・差分・出典", () => {
  it("旧JSONと追加スキーマを読み、新規source・日付・精度・provenanceを検証する", () => {
    expect(validateSchema(sampleData())).toEqual([]);
    const data = enriched();
    expect(validateSchema(data)).toEqual([]);
    data.sources.modelsDev!.sha256 = "invalid";
    data.models[0].releaseDate = "2026-02-30";
    expect(validateSchema(data).length).toBeGreaterThanOrEqual(2);
  });
  it("取得日時・生データハッシュだけの変化を意味的な価格変更とみなさない", () => {
    const a = enriched(), b = structuredClone(a);
    b.generatedAt = "2026-10-18T00:00:00Z";
    b.sources.modelsDev!.fetchedAt = b.generatedAt;
    b.sources.modelsDev!.sha256 = "b".repeat(64);
    b.sources.modelsDev!.bytes = 2000;
    expect(contentHash(a)).toBe(contentHash(b));
    b.models[0].prices[0].provenance = { input: source };
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
  it("全ティア・長文・cacheの値変わりと採用元変更をレポートへ出す", () => {
    const a = enriched(), b = structuredClone(a);
    b.models[0].prices.push({ tier: "priority", minPromptTokens: 272000, input: 4, output: 15, cacheWrite1h: 8, provenance: { input: source } });
    a.models[0].prices.push({ tier: "priority", minPromptTokens: 272000, input: 4, output: 15, cacheWrite1h: 4 });
    const diff = diffData(a, b);
    expect(diff.up.some(n => n.includes("cacheWrite1h"))).toBe(true);
    expect(diff.sourceChanges.some(n => n.includes("models.dev"))).toBe(true);
    const report = diffMarkdown(diff, { stop: [], notes: [] }, b, { mismatches: [], candidates: [], unparsed: [], unsupportedImages: [] });
    expect(report).toContain("SHA-256=");
    expect(report).toContain("採用元変更");
    expect(evaluateGates(a, b, loadGates()).stop.some(n => n.includes("cacheWrite1h"))).toBe(true);
  });
  it("models.devのサイズ・provider別件数・source欠落を統合モデル総数とは別に検出する", () => {
    const a = enriched(), b = structuredClone(a);
    b.sources.modelsDev!.counts = { openai: 1 };
    expect(evaluateGates(a, b, loadGates()).stop.some(n => n.includes("openai"))).toBe(true);
    b.sources.modelsDev!.bytes = 10;
    expect(evaluateGates(a, b, loadGates()).stop.some(n => n.includes("取得サイズ"))).toBe(true);
    delete b.sources.modelsDev;
    expect(evaluateGates(a, b, loadGates()).stop.some(n => n.includes("出典が欠落"))).toBe(true);
  });
  it("価格採用元と年月精度のリリース日出典を表示し、旧JSONの出典にも対応する", () => {
    const m = enriched().models.find(m => m.id === "gpt-6.1-sol@openai:global")!;
    m.prices[0].provenance = { input: source };
    const html = sourceCell(m);
    expect(html).toContain("models.dev");
    expect(html).toContain("2026-09 (年月)");
    expect(html).toContain(MODELS_DEV_URL);
    delete m.prices[0].provenance;
    delete m.releaseDateSource;
    expect(sourceCell(m)).toContain("LiteLLM");
  });
});
