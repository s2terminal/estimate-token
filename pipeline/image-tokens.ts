import { configuredImageUnsupportedReason, requiresImageConversion, resolveImageTokenProfile, type ImageTokenConfig } from "../shared/image-token-config.ts";
import type { Model } from "../shared/types.ts";

export function unsupportedImageModels(models: Model[], previous: Model[] = [], config?: ImageTokenConfig) {
  const needsConversion = (m: Model) => m.category === "image" &&
    (configuredImageUnsupportedReason(m.family, config, m.platform) != null || m.prices.some((r) => requiresImageConversion(m, r, config)));
  const known = new Set(previous.filter(needsConversion).map((m) => m.id));
  const all = models.filter(needsConversion).flatMap((m) => {
    const resolved = resolveImageTokenProfile(m.family, config, m.platform);
    if (!resolved.profile) return [{ id: m.id, reason: resolved.reason }];
    return m.prices.some((r) => requiresImageConversion(m, r, config) && r.imageOutput == null)
      ? [{ id: m.id, reason: "画像出力トークン単価が未取得のため試算できません" }] : [];
  });
  return { all, added: all.filter((m) => !known.has(m.id)) };
}
