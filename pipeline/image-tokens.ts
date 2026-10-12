import { resolveImageTokenProfile, type ImageTokenConfig } from "../shared/image-token-config.ts";
import type { Model } from "../shared/types.ts";

/** 1枚単価がないトークン課金の画像モデルだけが換算プロファイルを必要とする。 */
const needsConversion = (m: Model) => m.category === "image" && m.prices.some((r) =>
  r.imageOutput != null && r.perImage == null && !r.perImageByRes);

export function unsupportedImageModels(models: Model[], previous: Model[] = [], config?: ImageTokenConfig) {
  const known = new Set(previous.filter(needsConversion).map((m) => m.id));
  const all = models.filter(needsConversion).flatMap((m) => {
    const resolved = resolveImageTokenProfile(m.family, config);
    return resolved.profile ? [] : [{ id: m.id, reason: resolved.reason }];
  });
  return { all, added: all.filter((m) => !known.has(m.id)) };
}
