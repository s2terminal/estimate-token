import { describe, expect, it } from "vitest";
import { calcImage } from "../../src/lib/calc.ts";
import { unsupportedImageModels } from "../../pipeline/image-tokens.ts";
import type { Platform } from "../../shared/types.ts";
import { sampleModel } from "../support/fixtures.ts";
import { calculated } from "../support/calc.ts";

const get = (family: string, platform: Platform = "gemini-api") => sampleModel(`${family}@${platform}:global`);

describe("Geminiの公式解像度別料金", () => {
  it.each([
    ["gemini-nano-banana-2.1", "1K", 1120, 33.6],
    ["gemini-nano-banana-2.1", "2K", 1680, 50.4],
    ["gemini-nano-banana-2.1", "4K", 3780, 113.4],
    ["gemini-3.1-flash-image", "1K", 1120, 67.2],
    ["gemini-3.1-flash-image", "2K", 1680, 100.8],
    ["gemini-3.1-flash-image", "4K", 2520, 151.2],
    ["gemini-3-pro-image", "1K", 1120, 134.4],
    ["gemini-3-pro-image", "2K", 1120, 134.4],
    ["gemini-3-pro-image", "4K", 2000, 240],
    ["gemini-3.1-flash-lite-image", "1K", 1120, 33.6],
  ] as const)("%s / %s: %s tokens、1000枚=$%s", (family, r, tokens, usd) => {
    for (const platform of ["gemini-api", "vertex-ai"] as const) {
      const result = calculated(calcImage(get(family, platform), { n: 1000, r, q: "max" }));
      expect(result.imageTokens).toBe(tokens);
      expect(result.usd).toBeCloseTo(usd, 10);
      expect(result.flags.some((f) => f.t.includes("テキスト出力・検索は別料金"))).toBe(true);
      expect(result.flags.some((f) => f.t.includes("実験的"))).toBe(false);
    }
  });

  it.each(["2K", "4K"])("Flash Liteの%sは共通単価に戻さず理由付きで計算不可", (r) => {
    const result = calcImage(get("gemini-3.1-flash-lite-image"), { n: 1000, r });
    expect(result.na && result.why).toBe(`${r}は非対応です(対応解像度: 1K)`);
  });

  it("旧2.5の提供終了メッセージをGemini APIに限定し、Vertex AIは1Kのみ計算する", () => {
    const api = calcImage(get("gemini-2.5-flash-image"), { n: 1000, r: "1K" });
    expect(api.na && api.why).toContain("2026-10-02に提供終了");
    const vertex = calcImage(get("gemini-2.5-flash-image", "vertex-ai"), { n: 1000, r: "1K" });
    expect(!vertex.na && vertex.usd).toBeCloseTo(38.7, 10);
    expect(calcImage(get("gemini-2.5-flash-image", "vertex-ai"), { n: 1000, r: "4K" }).na).toBe(true);
    const unsupported = unsupportedImageModels([get("gemini-2.5-flash-image"), get("gemini-2.5-flash-image", "vertex-ai")]);
    expect(unsupported.all.map(m => m.id)).toEqual(["gemini-2.5-flash-image@gemini-api:global"]);
  });

  it("換算未対応の新しいGoogle画像モデルは共通単価で推測しない", () => {
    const m = { ...get("gemini-3.1-flash-image"), family: "gemini-future-image", id: "gemini-future-image@gemini-api:global" };
    const result = calcImage(m, { n: 100, r: "4K" });
    expect(result.na && result.why).toContain("換算仕様は未対応");
    expect(unsupportedImageModels([m]).added[0].id).toBe(m.id);
  });

  it("単価未取得も共通単価へ戻さず、画面とレポートに理由を出す", () => {
    const m = { ...get("gemini-3.1-flash-image"), prices: [{ tier: "standard" as const, minPromptTokens: 0, perImage: 0.045 }] };
    const result = calcImage(m, { n: 100, r: "1K" });
    expect(result.na && result.why).toContain("単価が未取得");
    expect(unsupportedImageModels([m]).all[0].reason).toContain("単価が未取得");
  });

  it("出典の単価更新を解像度別計算へ反映する", () => {
    const original = get("gemini-3.1-flash-image");
    const m = { ...original, prices: [{ ...original.prices[0], imageOutput: 66 }] };
    const result = calcImage(m, { n: 1000, r: "2K" });
    expect(!result.na && result.usd).toBeCloseTo(110.88, 10);
  });

  it("Geminiの4Kは解像度キーを使い、OpenAIの横長サイズを流用しない", () => {
    const m = get("gemini-nano-banana-2.1");
    const result = calcImage(m, { n: 0, r: "4K" });
    expect(!result.na && result.imageTokens).toBe(3780);
    expect(!result.na && result.usd).toBe(0);
  });

  it("他社の共通単価とトークン単価を持つモデルにGoogleの優先規則を適用しない", () => {
    const m = { ...get("gemini-3.1-flash-image"), family: "other-image", vendor: "その他", prices: [{ tier: "standard" as const, minPromptTokens: 0, perImage: 0.1, imageOutput: 60 }] };
    const result = calcImage(m, { n: 100, r: "4K" });
    expect(!result.na && result.usd).toBe(10);
  });

  it("Geminiの解像度別単価にOpenAIの画質が影響しない", () => {
    const model = get("gemini-3.1-flash-image");
    expect(calcImage(model, { n: 1000, r: "2K", q: "max" })).toEqual(calcImage(model, { n: 1000, r: "2K", q: "low" }));
  });
});
