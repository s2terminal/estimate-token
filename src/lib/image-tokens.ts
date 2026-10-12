/** OpenAI の画像「出力」トークンの概算。入力画像用の vision 計算とは別。
 * 根拠と確認日: docs/image-tokens.md (2026-10-11)
 */
import { resolveImageTokenProfile, type ImageQuality, type ImageTokenConfig } from "../../shared/image-token-config.ts";
export { IMAGE_QUALITIES, type ImageQuality } from "../../shared/image-token-config.ts";

export type ImageTokenEstimate = { tokens: number; why?: never } | { tokens?: never; why: string };

/** 公式計算機と同じ、ちょうど .5 の場合は偶数側に丸める。 */
const roundEven = (v: number) => {
  const floor = Math.floor(v);
  return v - floor === 0.5 ? floor + (floor % 2) : Math.round(v);
};

export function estimateImageTokens(family: string, width: number, height: number, quality: ImageQuality, config?: ImageTokenConfig): ImageTokenEstimate {
  if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0))
    return { why: "幅・高さは正の整数で指定してください" };

  const resolved = resolveImageTokenProfile(family, config);
  if (!resolved.profile) return { why: resolved.reason };
  const profile = resolved.profile;
  if (profile.method === "grid") {
    const size = profile.size;
    if (width % size.multiple || height % size.multiple) return { why: `幅・高さは${size.multiple}の倍数で指定してください` };
    const long = Math.max(width, height), short = Math.min(width, height);
    const pixels = width * height;
    if (long > size.maxEdge) return { why: `最大辺は${size.maxEdge}pxまでです` };
    if (long / short > size.maxAspectRatio) return { why: `縦横比は1:${size.maxAspectRatio}〜${size.maxAspectRatio}:1で指定してください` };
    if (pixels < size.minPixels || pixels > size.maxPixels)
      return { why: `画素数は${size.minPixels.toLocaleString("ja-JP")}〜${size.maxPixels.toLocaleString("ja-JP")}で指定してください` };

    const grid = profile.grids[quality];
    if (grid == null) return { why: `このモデルは画質 ${quality} に対応していません` };
    const shortGrid = roundEven(grid / (long / short));
    return { tokens: Math.ceil(grid * shortGrid * (profile.pixelOffset + pixels) / profile.pixelDivisor) };
  }

  const values = profile.tokensBySize[`${width}x${height}`];
  if (!values) return { why: `このモデルは${Object.keys(profile.tokensBySize).map((s) => s.replace("x", "×")).join("・")}のみ換算できます` };
  const tokens = values[quality];
  return tokens == null ? { why: `このモデルは画質 ${quality} に対応していません` } : { tokens };
}
