import data from "../config/image-tokens.json";
import type { Model, PriceRule } from "./types.ts";

export const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
type QualityValues = Partial<Record<ImageQuality, number>>;
interface Evidence { source: string; reviewedAt: string }
export interface GridProfile extends Evidence {
  method: "grid";
  size: { multiple: number; maxEdge: number; maxAspectRatio: number; minPixels: number; maxPixels: number };
  grids: QualityValues;
  pixelOffset: number;
  pixelDivisor: number;
}
export interface TableProfile extends Evidence {
  method: "table";
  tokensBySize: Record<string, QualityValues>;
}
export interface ResolutionProfile extends Evidence {
  method: "resolution";
  tokensByResolution: Record<string, number>;
}
export type ImageTokenProfile = GridProfile | TableProfile | ResolutionProfile;
export interface ImageTokenConfig {
  /** このベンダーの画像は共通の1枚単価ではなく解像度別トークン課金を優先 */
  preferTokenVendors?: string[];
  profiles: Record<string, ImageTokenProfile>;
  models: Record<string, { profile: string; unsupportedReason?: never } | { profile?: never; unsupportedReason: string }>;
}

/** 設定ミスで誤った見積もりを公開しないよう、パイプラインと画面の起動時に検証する。 */
export function validateImageTokenConfig(config: ImageTokenConfig): string[] {
  const errors: string[] = [];
  if (config.preferTokenVendors != null && (!Array.isArray(config.preferTokenVendors) ||
    !config.preferTokenVendors.every((vendor) => typeof vendor === "string" && vendor.trim())))
    errors.push("preferTokenVendorsが不正");
  const positive = (v: number) => Number.isFinite(v) && v > 0;
  const qualitiesValid = (values: QualityValues, integers: boolean) => Object.keys(values).length > 0 &&
    Object.entries(values).every(([q, v]) => IMAGE_QUALITIES.includes(q as ImageQuality) && positive(v!) && (!integers || Number.isSafeInteger(v)));
  for (const [id, p] of Object.entries(config.profiles)) {
    if (!p.source?.startsWith("https://") || !/^\d{4}-\d{2}-\d{2}$/.test(p.reviewedAt)) errors.push(`${id}: 出典URL・確認日が不正`);
    if (p.method === "grid") {
      if (!p.size || !Object.values(p.size).every(positive) || !Number.isSafeInteger(p.size.multiple) ||
        p.size.minPixels > p.size.maxPixels || p.size.maxAspectRatio < 1 ||
        !positive(p.pixelOffset) || !positive(p.pixelDivisor) || !qualitiesValid(p.grids, true))
        errors.push(`${id}: gridの換算パラメータが不正`);
    } else if (p.method === "table") {
      if (!Object.keys(p.tokensBySize).length || Object.entries(p.tokensBySize).some(([size, values]) =>
        !/^[1-9]\d*x[1-9]\d*$/.test(size) || !qualitiesValid(values, true))) errors.push(`${id}: tokensBySizeが不正`);
    } else if (p.method === "resolution") {
      if (!Object.keys(p.tokensByResolution).length || Object.entries(p.tokensByResolution).some(([r, tokens]) =>
        !["1K", "2K", "4K"].includes(r) || !positive(tokens) || !Number.isSafeInteger(tokens))) errors.push(`${id}: tokensByResolutionが不正`);
    } else errors.push(`${id}: 未知の換算方式`);
  }
  for (const [family, entry] of Object.entries(config.models)) {
    if (entry.profile != null ? !Object.hasOwn(config.profiles, entry.profile) || entry.unsupportedReason != null : !entry.unsupportedReason)
      errors.push(`${family}: プロファイル参照または未対応理由が不正`);
  }
  return errors;
}

export const IMAGE_TOKEN_CONFIG = data as ImageTokenConfig;
const errors = validateImageTokenConfig(IMAGE_TOKEN_CONFIG);
if (errors.length) throw new Error(`config/image-tokens.json: ${errors.join("; ")}`);

export type ProfileResolution = { profile: ImageTokenProfile; reason?: never } | { profile?: never; reason: string };
const modelEntry = (family: string, config: ImageTokenConfig, platform?: string) => {
  const model = family.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  if (platform && Object.hasOwn(config.models, `${model}@${platform}`)) return config.models[`${model}@${platform}`];
  return Object.hasOwn(config.models, model) ? config.models[model] : undefined;
};
export function resolveImageTokenProfile(family: string, config: ImageTokenConfig = IMAGE_TOKEN_CONFIG, platform?: string): ProfileResolution {
  const entry = modelEntry(family, config, platform);
  if (entry?.profile != null && Object.hasOwn(config.profiles, entry.profile)) return { profile: config.profiles[entry.profile] };
  return { reason: entry?.unsupportedReason ?? "このモデルの解像度・画質から出力トークン数への換算仕様は未対応です" };
}

export const configuredImageUnsupportedReason = (family: string, config: ImageTokenConfig = IMAGE_TOKEN_CONFIG, platform?: string) =>
  modelEntry(family, config, platform)?.unsupportedReason;

/** 明示的な解像度別1枚単価は優先。共通単価には別解像度の料金が混在するためGoogleはトークン課金を優先。 */
export const requiresImageConversion = (m: Pick<Model, "category" | "vendor" | "family">, r: PriceRule, config: ImageTokenConfig = IMAGE_TOKEN_CONFIG) =>
  m.category === "image" && !r.perImageByRes && (r.imageOutput != null &&
    (r.perImage == null || (config.preferTokenVendors ?? []).includes(m.vendor)) ||
    resolveImageTokenProfile(m.family, config).profile?.method === "resolution");
