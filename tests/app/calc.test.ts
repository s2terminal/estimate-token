import { describe, expect, it } from "vitest";
import type { Model } from "../../shared/types.ts";
import { type LlmUsage, calcLlm, pickRule } from "../../src/lib/calc.ts";
import { sampleModel as get } from "../support/fixtures.ts";
import { calculated as ok } from "../support/calc.ts";

const usage = (o: Partial<LlmUsage> = {}): LlmUsage => ({ n: 10000, i: 2000, o: 500, c: false, h: 0, tier: "standard", ...o });

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
