import { describe, expect, it } from "vitest";
import { IMAGE_TOKEN_CONFIG, resolveImageTokenProfile, validateImageTokenConfig } from "../shared/image-token-config.ts";
import { estimateImageTokens } from "../src/lib/image-tokens.ts";

describe("画像換算の設定", () => {
  it("公開設定の出典・係数・参照を検証する", () => {
    expect(validateImageTokenConfig(IMAGE_TOKEN_CONFIG)).toEqual([]);
  });

  it("新モデルは対応設定を足せば既存の換算方式を利用できる", () => {
    const config = structuredClone(IMAGE_TOKEN_CONFIG);
    config.models["future-image-model"] = { profile: "openai-image-2.5" };
    expect(estimateImageTokens("future-image-model", 1024, 1024, "low", config)).toEqual({ tokens: 196 });
    expect(estimateImageTokens("future-image-model-2027-01-01", 1024, 1024, "low", config)).toEqual({ tokens: 196 });
    // 元の設定にないモデルへ、似た名前から推測して式を適用しない。
    expect(estimateImageTokens("gpt-image-2.5-other", 1024, 1024, "low").why).toBeTruthy();
  });

  it("新しい係数や対応表も設定だけで追加できる", () => {
    const config = structuredClone(IMAGE_TOKEN_CONFIG);
    config.profiles.custom = {
      method: "table", source: "https://example.com/pricing", reviewedAt: "2026-10-11",
      tokensBySize: { "512x512": { low: 100 } },
    };
    config.models["custom-image"] = { profile: "custom" };
    expect(validateImageTokenConfig(config)).toEqual([]);
    expect(estimateImageTokens("custom-image", 512, 512, "low", config)).toEqual({ tokens: 100 });
  });

  it("存在しないプロファイル・不正な係数の設定を検知する", () => {
    const config = structuredClone(IMAGE_TOKEN_CONFIG);
    config.models["future-image"] = { profile: "missing" };
    const profile = config.profiles["openai-image-2"];
    if (profile.method !== "grid") throw new Error("fixture");
    profile.pixelDivisor = 0;
    profile.grids.low = NaN;
    expect(validateImageTokenConfig(config)).toHaveLength(2);
    expect(resolveImageTokenProfile("future-image", config).reason).toBeTruthy();
  });
});
