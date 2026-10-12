import { describe, expect, it } from "vitest";
import { estimateImageTokens } from "../../src/lib/image-tokens.ts";

describe("OpenAIの公式換算", () => {
  it.each(["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2.5-flare-2026-09-08"])("%s: 公式計算機の1024×1024 / lowは196 tokens", (model) => {
    expect(estimateImageTokens(model, 1024, 1024, "low")).toEqual({ tokens: 196 });
  });

  it("同じ解像度でも2と2.5は画質別のtoken数が違う", () => {
    expect(estimateImageTokens("gpt-image-2", 1024, 1024, "medium")).toEqual({ tokens: 1756 });
    expect(estimateImageTokens("gpt-image-2.5-flare", 1024, 1024, "medium")).toEqual({ tokens: 439 });
    expect(estimateImageTokens("gpt-image-2.5-sunburst", 1024, 1024, "max")).toEqual({ tokens: 7024 });
  });

  it("縦横比と.5の偶数丸めを適用し、縦横を入れ替えても同じ", () => {
    expect(estimateImageTokens("gpt-image-2", 1536, 1024, "medium")).toEqual({ tokens: 1372 });
    expect(estimateImageTokens("gpt-image-2", 1024, 1536, "medium")).toEqual({ tokens: 1372 });
    // 16*1008/1536=10.5 → 10 (11に丸めると別料金になる)
    expect(estimateImageTokens("gpt-image-2.5-flare", 1536, 1008, "low")).toEqual({ tokens: 142 });
  });

  it.each([
    [1000, 1024], [4096, 2048], [1024, 256], [3840, 1024], [3840, 3840], [0, 1024], [Infinity, 1024], [1024.5, 1024],
  ])("無効なサイズ %s×%s は計算不可", (w, h) => {
    expect(estimateImageTokens("gpt-image-2.5-flare", w, h, "medium").why).toBeTruthy();
  });

  it("画素数の上下限は含む", () => {
    expect(estimateImageTokens("gpt-image-2.5-flare", 1024, 640, "low").tokens).toBeGreaterThan(0);
    expect(estimateImageTokens("gpt-image-2.5-flare", 3840, 2160, "low").tokens).toBeGreaterThan(0);
  });

  it("旧モデルの公式表は縦横の区別を保持する", () => {
    expect(estimateImageTokens("gpt-image-1.5", 1024, 1536, "high")).toEqual({ tokens: 6240 });
    expect(estimateImageTokens("gpt-image-1", 1536, 1024, "high")).toEqual({ tokens: 6208 });
    expect(estimateImageTokens("gpt-image-1.5", 2048, 2048, "medium").why).toBeTruthy();
  });

  it("非対応の画質・未知モデル・Mini・可変の別名に換算式を流用しない", () => {
    expect(estimateImageTokens("gpt-image-2", 1024, 1024, "xhigh").why).toBeTruthy();
    for (const model of ["gpt-image-1-mini", "gpt-image-3", "chatgpt-image-latest"])
      expect(estimateImageTokens(model, 1024, 1024, "medium").why).toBeTruthy();
  });
});
