import { describe, expect, it } from "vitest";
import type { Model } from "../shared/types.ts";
import { type LlmUsage, calcImage, calcLlm, pickRule } from "../src/lib/calc.ts";
import { sampleData } from "./helpers.ts";

const models = sampleData().models;
const get = (id: string) => models.find((m) => m.id === id)!;
const usage = (o: Partial<LlmUsage> = {}): LlmUsage => ({ n: 10000, i: 2000, o: 500, c: false, h: 0, tier: "standard", ...o });
const ok = (r: ReturnType<typeof calcLlm>) => {
  if (r.na) throw new Error(r.why);
  return r;
};

describe("calcLlm", () => {
  it("月10,000回、入力2,000/出力500、GPT-6.1 Sol → $90", () => {
    expect(ok(calcLlm(get("gpt-6.1-sol@openai:global"), usage())).usd).toBeCloseTo(90, 10);
  });

  it("Batch は batch のルールで計算する", () => {
    expect(ok(calcLlm(get("gpt-6.1-sol@openai:global"), usage({ tier: "batch" }))).usd).toBeCloseTo(45, 10);
  });

  it("そのプランがないモデルは standard で計算して注記する", () => {
    const r = ok(calcLlm(get("gpt-6.1-sol@azure:us"), usage({ tier: "batch" })));
    expect(r.rule.tier).toBe("standard");
    expect(r.flags.map((f) => f.t)).toContain("Batchなし→Standard");
  });

  it("長文価格の境界: 272,000 は通常、272,001 は長文", () => {
    const m = get("gpt-6.1-sol@openai:global");
    expect(ok(calcLlm(m, usage({ i: 272000 }))).pin).toBe(2);
    const long = ok(calcLlm(m, usage({ i: 272001 })));
    expect(long.pin).toBe(4);
    expect(long.pout).toBe(15);
    expect(long.flags.map((f) => f.t)).toContain("長文価格(>272K)");
  });

  it("キャッシュヒット率の分を cacheRead で計算する", () => {
    // 10,000回 × (800×2 + 1,200×0.1 + 500×10) / 1e6 = 67.2
    expect(ok(calcLlm(get("gpt-6.1-sol@openai:global"), usage({ c: true, h: 60 }))).usd).toBeCloseTo(67.2, 10);
  });

  it("cacheRead がないモデルは全量を通常入力にして注記する", () => {
    const m: Model = { ...get("gpt-6.1-sol@openai:global"), prices: [{ tier: "standard", minPromptTokens: 0, input: 2, output: 10 }] };
    const r = ok(calcLlm(m, usage({ c: true, h: 60 })));
    expect(r.usd).toBeCloseTo(90, 10);
    expect(r.flags.map((f) => f.t)).toContain("キャッシュ単価なし");
  });

  it("価格がなければ計算不可", () => {
    const m: Model = { ...get("gpt-6.1-sol@openai:global"), prices: [] };
    expect(calcLlm(m, usage()).na).toBe(true);
  });
});

describe("pickRule", () => {
  it("期間限定価格は基準日とフラグで切り替える", () => {
    const prices = [
      { tier: "standard" as const, minPromptTokens: 0, input: 0.75, output: 3.75, promo: true, validTo: "2026-12-31" },
      { tier: "standard" as const, minPromptTokens: 0, input: 1.5, output: 7.5, validFrom: "2027-01-01" },
    ];
    expect(pickRule(prices, "standard", 0, { asOf: "2026-10-11", promo: true }).rule?.input).toBe(0.75);
    expect(pickRule(prices, "standard", 0, { asOf: "2027-01-01", promo: true }).rule?.input).toBe(1.5);
    expect(pickRule(prices, "standard", 0, { asOf: "2026-10-11", promo: false }).rule).toBeNull();
  });
});

describe("calcImage", () => {
  it("1枚単価 × 枚数", () => {
    const r = calcImage(get("gemini-3.1-flash-image@gemini-api:global"), { n: 1000, r: "1K" });
    expect(r.na).toBe(false);
    if (!r.na) expect(r.usd).toBeCloseTo(45, 10);
  });

  it("解像度別単価を優先する", () => {
    const m: Model = { ...get("gemini-3.1-flash-image@gemini-api:global"), prices: [{ tier: "standard", minPromptTokens: 0, perImage: 0.05, perImageByRes: { "2K": 0.1 } }] };
    const r2 = calcImage(m, { n: 10, r: "2K" });
    const r4 = calcImage(m, { n: 10, r: "4K" });
    expect(!r2.na && r2.usd).toBeCloseTo(1, 10);
    expect(!r4.na && r4.usd).toBeCloseTo(0.5, 10);
  });

  it("どちらもなければ計算不可", () => {
    const m: Model = { ...get("gemini-3.1-flash-image@gemini-api:global"), prices: [{ tier: "standard", minPromptTokens: 0 }] };
    expect(calcImage(m, { n: 10, r: "1K" }).na).toBe(true);
  });
});
