import { describe, expect, it } from "vitest";
import type { Model } from "../../shared/types.ts";
import { calcImage } from "../../src/lib/calc.ts";
import { sampleModel as get } from "../support/fixtures.ts";
import { calculated as ok } from "../support/calc.ts";

describe("calcImage", () => {
  it("画像生成も割引の設定と期間に従って入力・出力料金を切り替える", () => {
    const regular = { tier: "standard" as const, minPromptTokens: 0, input: 5, imageOutput: 30 };
    const m = { ...get("gpt-image-2.5-sunburst@openai:global"), prices: [
      regular,
      { ...regular, input: 2.5, imageOutput: 15, promo: true, validTo: "2026-10-31" },
    ] };
    const usage = { n: 1000, i: 500, r: "1K", q: "low" as const };
    expect(ok(calcImage(m, usage)).usd).toBeCloseTo(8.38);
    expect(ok(calcImage(m, usage, { asOf: "2026-10-18", promo: false })).usd).toBeCloseTo(8.38);
    expect(ok(calcImage(m, usage, { asOf: "2026-10-18", promo: true })).usd).toBeCloseTo(4.19);
    expect(ok(calcImage(m, usage, { asOf: "2026-11-01", promo: true })).usd).toBeCloseTo(8.38);
    const promoOnly = { ...m, prices: [m.prices[1]] };
    expect(calcImage(promoOnly, usage, { asOf: "2026-10-18", promo: false }).na).toBe(true);
  });

  it("入力(プロンプト)tokensを入力単価で足す", () => {
    // 196 tokens × $30/1M + 500 tokens × $5/1M = $0.00838/枚
    const r = ok(calcImage(get("gpt-image-2.5-sunburst@openai:global"), { n: 1000, i: 500, r: "1K", q: "low" }));
    expect(r.usd).toBeCloseTo(8.38, 10);
    expect(r.flags.map((f) => f.t)).toContain("入力画像・部分画像は別料金");
    expect(r.perImage).toBeCloseTo(0.00838, 12);
    expect(r.parts).toEqual([{ k: "in", v: expect.closeTo(2.5, 10) }, { k: "out", v: expect.closeTo(5.88, 10) }]);
    // Geminiの解像度別換算: 1120 tokens × $60/1M + 500 tokens × $0.5/1M
    const g = ok(calcImage(get("gemini-3.1-flash-image@gemini-api:global"), { n: 1000, i: 500, r: "1K" }));
    expect(g.usd).toBeCloseTo(67.45, 10);
  });

  it("トークン課金で入力単価がなければ入力を含めず注記する。1枚単価だけのモデルは入力を足さない", () => {
    const m = get("gpt-image-2@openai:global");
    const r = ok(calcImage({ ...m, prices: [{ tier: "standard", minPromptTokens: 0, imageOutput: 30 }] }, { n: 100, i: 500, r: "1K", q: "low" }));
    expect(r.usd).toBeCloseTo(100 * 196 * 30 / 1e6, 10);
    expect(r.flags.map((f) => f.t)).toContain("入力単価なし(入力は含まず)");
    const flat: Model = { ...get("gemini-3.1-flash-image@gemini-api:global"), family: "flux-1.1-pro", vendor: "その他", prices: [{ tier: "standard", minPromptTokens: 0, perImage: 0.04 }] };
    const f = ok(calcImage(flat, { n: 10, i: 500, r: "1K" }));
    expect(f.usd).toBeCloseTo(0.4, 10);
    expect(f.flags).toEqual([]);
  });

  it("画質の指定がなければmedium", () => {
    expect(ok(calcImage(get("gpt-image-1.5@openai:global"), { n: 1000, r: "1K" })).usd).toBeCloseTo(33.792, 10);
  });

  it("トークン単価0は無料として扱い、無効サイズや未対応モデルは理由付きで計算不可", () => {
    const m = get("gpt-image-2@openai:global");
    expect(ok(calcImage({ ...m, prices: [{ tier: "standard", minPromptTokens: 0, imageOutput: 0 }] }, { n: 100, r: "1K" })).usd).toBe(0);
    const invalid = calcImage(m, { n: 100, r: "8K" });
    expect(invalid.na && invalid.why).toContain("1K・2K・4K");
    const mini = calcImage(get("gpt-image-1-mini@openai:global"), { n: 100, r: "1K" });
    expect(mini.na && mini.why).toContain("未対応");
  });

  it.each([["1K", 439], ["2K", 892], ["4K", 865]] as const)("OpenAIの%s選択から固定サイズのトークン数を計算する", (r, tokens) => {
    const result = ok(calcImage(get("gpt-image-2.5-sunburst@openai:global"), { n: 100, r, q: "medium" }));
    expect(result.imageTokens).toBe(tokens);
    expect(result.usd).toBeCloseTo(100 * tokens * 30 / 1e6, 10);
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
