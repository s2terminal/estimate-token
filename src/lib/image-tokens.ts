/** OpenAI の画像「出力」トークンの概算。入力画像用の vision 計算とは別。
 * 根拠と確認日: docs/image-tokens.md (2026-10-11)
 */
export const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

export type ImageTokenEstimate = { tokens: number; why?: never } | { tokens?: never; why: string };

/** 公式計算機と同じ、ちょうど .5 の場合は偶数側に丸める。 */
const roundEven = (v: number) => {
  const floor = Math.floor(v);
  return v - floor === 0.5 ? floor + (floor % 2) : Math.round(v);
};

export function estimateImageTokens(family: string, width: number, height: number, quality: ImageQuality): ImageTokenEstimate {
  if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0))
    return { why: "幅・高さは正の整数で指定してください" };

  const model = family.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  const modern = model === "gpt-image-2" || model === "gpt-image-2.5-sunburst" || model === "gpt-image-2.5-flare";
  if (modern) {
    if (width % 16 || height % 16) return { why: "幅・高さは16の倍数で指定してください" };
    const long = Math.max(width, height), short = Math.min(width, height);
    const pixels = width * height;
    if (long > 3840) return { why: "最大辺は3840pxまでです" };
    if (long / short > 3) return { why: "縦横比は1:3〜3:1で指定してください" };
    if (pixels < 655360 || pixels > 8294400) return { why: "画素数は655,360〜8,294,400で指定してください" };

    const grids: Partial<Record<ImageQuality, number>> = model === "gpt-image-2"
      ? { low: 16, medium: 48, high: 96 }
      : { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 };
    const grid = grids[quality];
    if (grid == null) return { why: `このモデルは画質 ${quality} に対応していません` };
    const shortGrid = roundEven(grid / (long / short));
    return { tokens: Math.ceil(grid * shortGrid * (2_000_000 + pixels) / 4_000_000) };
  }

  // Mini は公式の画像単価とこの表の換算値が一致しないため、同じ表を流用しない。
  if (model === "gpt-image-1" || model === "gpt-image-1.5") {
    const sizes = ["1024x1024", "1024x1536", "1536x1024"];
    const index = sizes.indexOf(`${width}x${height}`);
    if (index < 0) return { why: "このモデルは1024×1024・1024×1536・1536×1024のみ換算できます" };
    const table: Partial<Record<ImageQuality, number[]>> = {
      low: [272, 408, 400], medium: [1056, 1584, 1568], high: [4160, 6240, 6208],
    };
    const tokens = table[quality]?.[index];
    return tokens == null ? { why: `このモデルは画質 ${quality} に対応していません` } : { tokens };
  }
  if (model === "gpt-image-1-mini")
    return { why: "換算仕様は未対応です(Mini専用のトークン数を確認できず、旧モデルの表と公式単価も不一致)" };
  if (model === "chatgpt-image-latest")
    return { why: "換算仕様は未対応です(chatgpt-image-latestの参照先モデルを固定できません)" };
  return { why: "このモデルの解像度・画質から出力トークン数への換算仕様は未対応です" };
}
