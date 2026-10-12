import { describe, expect, it } from "vitest";
import { calculated as ok } from "../support/calc.ts";
import type { Model, Platform, PriceRule } from "../../shared/types.ts";
import { calcImage, calcLlm, type LlmUsage } from "../../src/lib/calc.ts";

/** 確認日: 2026-10-12。詳細・採用範囲は docs/official-pricing-examples.md。
 * 公式例の単価を固定し、日次更新される latest.json / LiteLLM には依存しない。
 * 期待値はリテラルで保持し、計算対象の関数から生成しない。
 */
const sources = {
  openaiText: "https://developers.openai.com/cookbook/examples/partners/model_selection_guide/model_selection_guide#cost-breakdown",
  openaiImage: "https://developers.openai.com/api/docs/guides/image-generation#calculating-costs",
  openaiImageLegacy: "https://developers.openai.com/api/docs/models/gpt-image-1.5",
  gemini: "https://ai.google.dev/gemini-api/docs/pricing",
  anthropicText: "https://platform.claude.com/docs/en/about-claude/pricing#worked-example",
  anthropicImage: "https://platform.claude.com/docs/en/build-with-claude/vision#resolution-and-token-cost",
};

function model(family: string, platform: Platform, source: string, prices: PriceRule[], category: Model["category"] = "llm"): Model {
  return {
    id: `${family}@${platform}:global`, family, name: family,
    vendor: platform === "gemini-api" ? "Google" : platform === "openai" ? "OpenAI" : "Anthropic",
    platform, region: "global", category, firstSeen: "2026-10-12", status: "active",
    prices, sources: [{ url: source }],
  };
}

const usage = (values: Partial<LlmUsage>): LlmUsage => ({ n: 1, i: 0, o: 0, c: false, h: 0, tier: "standard", ...values });
describe("公式計算例: OpenAI のトークン課金 (Cookbook / Cost Breakdown)", () => {
  // OCRの入力は画像を含み得るが、ここでは資料の合計入力tokensを使用する。
  const stages = [
    { family: "gpt-4.1", i: 2000, o: 1500, input: 1, output: 4, inUsd: 0.002, outUsd: 0.006, thousandUsd: 8 },
    { family: "o4-mini", i: 2000, o: 3000, input: 0.55, output: 2.2, inUsd: 0.0011, outUsd: 0.0066, thousandUsd: 7.7 },
  ];
  const calculate = (stage: typeof stages[number], n: number) => ok(calcLlm(
    model(stage.family, "openai", sources.openaiText, [{ tier: "batch", minPromptTokens: 0, input: stage.input, output: stage.output }]),
    usage({ n, i: stage.i, o: stage.o, tier: "batch" }),
  ));

  it.each(stages)("$family: 入出力の内訳と1,000ページの公式合計", (stage) => {
    const one = calculate(stage, 1);
    expect(one.rule.tier).toBe("batch");
    expect(one.parts).toEqual([
      { k: "in", v: expect.closeTo(stage.inUsd, 12) }, { k: "cache", v: 0 },
      { k: "out", v: expect.closeTo(stage.outUsd, 12) },
    ]);
    expect(calculate(stage, 1000).usd).toBeCloseTo(stage.thousandUsd, 12);
  });

  it("2段階を合わせた公式合計は1,000ページで$15.70", () => {
    expect(calculate(stages[0], 1000).usd + calculate(stages[1], 1000).usd).toBeCloseTo(15.7, 12);
  });
});

describe("公式計算例: Anthropic のテキスト (Pricing / Worked example)", () => {
  const opus = model("claude-opus-5", "anthropic", sources.anthropicText, [
    { tier: "standard", minPromptTokens: 0, input: 5, output: 25, cacheRead: 0.5 },
  ]);

  it("入力50,000・出力15,000: 入力$0.25、出力$0.375", () => {
    const result = ok(calcLlm(opus, usage({ i: 50000, o: 15000 })));
    expect(result.parts).toEqual([
      { k: "in", v: expect.closeTo(0.25, 12) }, { k: "cache", v: 0 },
      { k: "out", v: expect.closeTo(0.375, 12) },
    ]);
    expect(result.usd).toBeCloseTo(0.625, 12);
    // runtimeはcalcLlmの対象外。資料の固定費$0.08を加えた全体も照合する。
    expect(result.usd + 0.08).toBeCloseTo(0.705, 12);
  });

  it("入力の40,000がcache read: 通常入力$0.05、キャッシュ$0.02", () => {
    // iは通常入力とキャッシュ入力の合計。40,000 / 50,000 = 80%。
    const result = ok(calcLlm(opus, usage({ i: 50000, o: 15000, c: true, h: 80 })));
    expect(result.parts).toEqual([
      { k: "in", v: expect.closeTo(0.05, 12) }, { k: "cache", v: expect.closeTo(0.02, 12) },
      { k: "out", v: expect.closeTo(0.375, 12) },
    ]);
    expect(result.usd).toBeCloseTo(0.445, 12);
    expect(result.usd + 0.08).toBeCloseTo(0.525, 12);
  });
});

describe("料金表由来の補助ケース: Gemini のテキスト (公式の計算例ではない)", () => {
  const flash = model("gemini-2.5-flash", "gemini-api", sources.gemini, [
    { tier: "standard", minPromptTokens: 0, input: 0.3, output: 2.5, cacheRead: 0.03 },
  ]);
  it("入力・出力それぞれ1M tokensの単価を再現する", () => {
    const result = ok(calcLlm(flash, usage({ i: 1000000, o: 1000000 })));
    expect(result.parts).toEqual([
      { k: "in", v: expect.closeTo(0.3, 12) }, { k: "cache", v: 0 },
      { k: "out", v: expect.closeTo(2.5, 12) },
    ]);
    expect(result.usd).toBeCloseTo(2.8, 12);
  });
  it("1M入力tokensがすべてcache readなら$0.03 (保存費は別)", () => {
    const result = ok(calcLlm(flash, usage({ i: 1000000, c: true, h: 100 })));
    expect(result.parts).toEqual([{ k: "in", v: 0 }, { k: "cache", v: expect.closeTo(0.03, 12) }, { k: "out", v: 0 }]);
    expect(result.usd).toBeCloseTo(0.03, 12);
  });
});

describe("公式計算例: OpenAI の画像出力 (Image generation)", () => {
  it("GPT Image 2.5の公式計算機: 1024×1024 / lowは196 tokens、$0.00588", () => {
    const m = model("gpt-image-2.5-sunburst", "openai", sources.openaiImage,
      [{ tier: "standard", minPromptTokens: 0, imageOutput: 30 }], "image");
    const result = ok(calcImage(m, { n: 1, r: "1K", q: "low" }));
    expect(result.imageTokens).toBe(196);
    expect(result.perImage).toBeCloseTo(0.00588, 12);
    expect(result.usd).toBeCloseTo(0.00588, 12);
  });

  it.each([
    { q: "low" as const, tokens: 272, exactUsd: 0.008704, documentedUsd: "0.009" },
    { q: "medium" as const, tokens: 1056, exactUsd: 0.033792, documentedUsd: "0.034" },
    { q: "high" as const, tokens: 4160, exactUsd: 0.13312, documentedUsd: "0.133" },
  ])("GPT Image 1.5 / $q: 1024×1024のトークン表と丸めた公式金額", (example) => {
    // $32/MTokの出典はモデルページのImage tokens / Output。
    const m = model("gpt-image-1.5", "openai", sources.openaiImageLegacy,
      [{ tier: "standard", minPromptTokens: 0, imageOutput: 32 }], "image");
    const result = ok(calcImage(m, { n: 1, r: "1K", q: example.q }));
    expect(result.imageTokens).toBe(example.tokens);
    expect(result.perImage).toBeCloseTo(example.exactUsd, 12);
    expect(result.usd).toBeCloseTo(example.exactUsd, 12);
    expect(result.usd.toFixed(3)).toBe(example.documentedUsd);
  });
});

describe("公式計算例: Gemini の画像出力 (Pricing / 各モデルの脚注)", () => {
  it.each([
    { family: "gemini-nano-banana-2.1", r: "1K", rate: 30, tokens: 1120, exactUsd: 0.0336, documentedUsd: "0.0336" },
    { family: "gemini-nano-banana-2.1", r: "2K", rate: 30, tokens: 1680, exactUsd: 0.0504, documentedUsd: "0.0504" },
    { family: "gemini-nano-banana-2.1", r: "4K", rate: 30, tokens: 3780, exactUsd: 0.1134, documentedUsd: "0.113" },
    { family: "gemini-3.1-flash-image", r: "1K", rate: 60, tokens: 1120, exactUsd: 0.0672, documentedUsd: "0.067" },
    { family: "gemini-3.1-flash-image", r: "2K", rate: 60, tokens: 1680, exactUsd: 0.1008, documentedUsd: "0.101" },
    { family: "gemini-3.1-flash-image", r: "4K", rate: 60, tokens: 2520, exactUsd: 0.1512, documentedUsd: "0.151" },
    { family: "gemini-3.1-flash-lite-image", r: "1K", rate: 30, tokens: 1120, exactUsd: 0.0336, documentedUsd: "0.0336" },
    { family: "gemini-3-pro-image", r: "1K", rate: 120, tokens: 1120, exactUsd: 0.1344, documentedUsd: "0.134" },
    { family: "gemini-3-pro-image", r: "2K", rate: 120, tokens: 1120, exactUsd: 0.1344, documentedUsd: "0.134" },
    { family: "gemini-3-pro-image", r: "4K", rate: 120, tokens: 2000, exactUsd: 0.24, documentedUsd: "0.24" },
  ])("$family / $r: $tokens tokens、公式表示は$$documentedUsd/枚", (example) => {
    const m = model(example.family, "gemini-api", sources.gemini,
      [{ tier: "standard", minPromptTokens: 0, imageOutput: example.rate }], "image");
    const result = ok(calcImage(m, { n: 1, r: example.r }));
    expect(result.imageTokens).toBe(example.tokens);
    expect(result.perImage).toBeCloseTo(example.exactUsd, 12);
    expect(result.usd).toBeCloseTo(example.exactUsd, 12);
    const decimals = example.documentedUsd.split(".")[1].length;
    expect(result.usd.toFixed(decimals)).toBe(example.documentedUsd);
  });

  it("Gemini 3 Pro Imageの画像入力: 560 tokensは公式表示で$0.0011/枚", () => {
    // 入力画像tokensは資料の値。画像出力を足さずcalcLlmの入力料金だけを検証。
    const m = model("gemini-3-pro-image", "gemini-api", sources.gemini,
      [{ tier: "standard", minPromptTokens: 0, input: 2, output: 12 }]);
    const result = ok(calcLlm(m, usage({ i: 560 })));
    expect(result.usd).toBeCloseTo(0.00112, 12);
    expect(result.usd.toFixed(4)).toBe("0.0011");
  });
});

describe("公式計算例: Anthropic の画像入力 (Vision / Resolution and token cost)", () => {
  // 画像の寸法→tokens換算はアプリ未実装。公式表のvisual tokensを入力に渡す。
  // n=1000は1,000枚を1リクエストに詰める意味ではなく、同じ入力の独立した1,000回。
  it.each([
    { family: "claude-haiku-4-5", size: "1000×1000", tokens: 1296, rate: 1, exactUsd: 1.296, documentedUsd: "1.30" },
    { family: "claude-opus-5", size: "1000×1000", tokens: 1296, rate: 5, exactUsd: 6.48, documentedUsd: "6.48" },
    { family: "claude-opus-5", size: "3840×2160→2576×1449", tokens: 4784, rate: 5, exactUsd: 23.92, documentedUsd: "23.92" },
  ])("$family / $size: $tokens tokens、1,000枚の公式表示は$$documentedUsd", (example) => {
    const m = model(example.family, "anthropic", sources.anthropicImage,
      [{ tier: "standard", minPromptTokens: 0, input: example.rate, output: 0 }]);
    const result = ok(calcLlm(m, usage({ n: 1000, i: example.tokens })));
    expect(result.usd).toBeCloseTo(example.exactUsd, 12);
    expect(result.parts).toEqual([
      { k: "in", v: expect.closeTo(example.exactUsd, 12) }, { k: "cache", v: 0 }, { k: "out", v: 0 },
    ]);
    expect(result.usd.toFixed(2)).toBe(example.documentedUsd);
  });
});
