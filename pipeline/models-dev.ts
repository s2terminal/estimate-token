import type { Platform, PriceRule } from "../shared/types.ts";
import { modelId, parseKey } from "./normalize.ts";
import { releaseDate } from "./recommend.ts";

export const MODELS_DEV_URL = "https://models.dev/catalog.json";
export const PROVIDERS: Record<string, Platform> = {
  openai: "openai", anthropic: "anthropic", google: "gemini-api",
  "google-vertex": "vertex-ai", "google-vertex-anthropic": "vertex-ai",
  "amazon-bedrock": "bedrock", azure: "azure", "azure-cognitive-services": "azure",
};
export interface CatalogModel {
  id: string;
  name: string;
  type?: string;
  canonical_model_id?: string;
  release_date?: string;
  status?: "alpha" | "beta" | "deprecated";
  modalities?: { input: string[]; output: string[] };
  limit?: { context: number; input?: number; output?: number };
  cost?: Record<string, unknown> & {
    input: number; output: number; cache_read?: number; cache_write?: number;
    tiers?: (Record<string, unknown> & { input: number; output: number; cache_read?: number; cache_write?: number; tier: { type: "context"; size: number } })[];
  };
  experimental?: { modes?: Record<string, unknown> };
  provider?: { body?: Record<string, unknown> };
  reasoning?: boolean;
  tool_call?: boolean;
}
export interface ModelsDevCatalog {
  models: Record<string, CatalogModel>;
  providers: Record<string, { id: string; models: Record<string, CatalogModel> }>;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const fail = (where: string): never => { throw new Error(`models.dev: ${where} の型が不正`); };

/** APIの既知項目を検証する。追加項目は保持し、正規化時に未対応項目として報告する。 */
export function validateCatalog(value: unknown): ModelsDevCatalog {
  if (!object(value) || !object(value.models) || !object(value.providers) ||
      !Object.keys(value.models).length || !Object.keys(value.providers).length) fail("catalog");
  const root = value as { models: Record<string, unknown>; providers: Record<string, unknown> };
  const cost = (v: unknown, where: string) => {
    if (!object(v) || !finite(v.input) || !finite(v.output)) fail(where);
    for (const [key, n] of Object.entries(v as Record<string, unknown>))
      if (!["tiers", "context_over_200k", "tier"].includes(key) && !finite(n)) fail(`${where}.${key}`);
  };
  const model = (v: unknown, id: string, where: string, provider = false) => {
    if (!object(v) || v.id !== id || typeof v.name !== "string" || !v.name) fail(where);
    const m = v as Record<string, unknown>;
    for (const key of ["release_date", "canonical_model_id", "type"])
      if (m[key] !== undefined && typeof m[key] !== "string") fail(`${where}.${key}`);
    if (m.status !== undefined && !["alpha", "beta", "deprecated"].includes(String(m.status))) fail(`${where}.status`);
    for (const key of ["reasoning", "tool_call"])
      if (m[key] !== undefined && typeof m[key] !== "boolean") fail(`${where}.${key}`);
    if (m.modalities !== undefined) {
      if (!object(m.modalities)) fail(`${where}.modalities`);
      for (const key of ["input", "output"]) {
        const a = (m.modalities as Record<string, unknown>)[key];
        if (!Array.isArray(a) || !a.every(x => typeof x === "string" && ["text", "image", "audio", "video", "pdf"].includes(x))) fail(`${where}.modalities.${key}`);
      }
    } else if (provider) fail(`${where}.modalities`);
    if (m.limit !== undefined) {
      if (!object(m.limit) || !finite(m.limit.context)) fail(`${where}.limit`);
      for (const key of ["input", "output"])
        if ((m.limit as Record<string, unknown>)[key] !== undefined && !finite((m.limit as Record<string, unknown>)[key])) fail(`${where}.limit.${key}`);
    } else if (provider) fail(`${where}.limit`);
    if (m.cost !== undefined) {
      cost(m.cost, `${where}.cost`);
      const c = m.cost as Record<string, unknown>;
      if (c.context_over_200k !== undefined) cost(c.context_over_200k, `${where}.cost.context_over_200k`);
      if (c.tiers !== undefined) {
        if (!Array.isArray(c.tiers)) fail(`${where}.cost.tiers`);
        const sizes = new Set<number>();
        for (const t of c.tiers as unknown[]) {
          cost(t, `${where}.cost.tiers[]`);
          if (!object(t) || !object(t.tier) || t.tier.type !== "context" ||
              !finite(t.tier.size) || !Number.isInteger(t.tier.size) || !t.tier.size || sizes.has(t.tier.size)) fail(`${where}.cost.tiers[].tier`);
          sizes.add((t as { tier: { size: number } }).tier.size);
        }
      }
    }
    if (m.experimental !== undefined && (!object(m.experimental) ||
        (m.experimental.modes !== undefined && !object(m.experimental.modes)))) fail(`${where}.experimental`);
    if (m.provider !== undefined && (!object(m.provider) ||
        (m.provider.body !== undefined && !object(m.provider.body)))) fail(`${where}.provider`);
  };
  for (const [id, m] of Object.entries(root.models)) model(m, id, `models.${id}`);
  for (const [id, p] of Object.entries(root.providers)) {
    if (!object(p) || p.id !== id || !object(p.models)) fail(`providers.${id}`);
    // 他providerの価格を採用しないが、ルートの破損は検出する。
    if (!(id in PROVIDERS)) continue;
    for (const [mid, m] of Object.entries((p as { models: Record<string, unknown> }).models)) model(m, mid, `${id}/${mid}`, true);
  }
  return value as ModelsDevCatalog;
}

export interface ModelsDevOffer {
  providerId: string;
  modelId: string;
  platform: Platform;
  appId: string;
  canonicalModelId?: string;
  commonReleaseDate?: string;
  model: CatalogModel;
  rules: PriceRule[];
  textOnly: boolean;
  url: string;
}
/** 採用条件を満たさず見送った候補。取得のたびにほぼ同じ内容が出るため、レポートでは理由ごとの件数にまとめる */
export interface Skip { reason: string; item: string }
export interface NormalizedModelsDev {
  catalog: ModelsDevCatalog;
  offers: ModelsDevOffer[];
  notes: string[];
  skipped: Skip[];
  counts: Record<string, number>;
}
export function normalizeModelsDev(catalog: ModelsDevCatalog): NormalizedModelsDev {
  const offers: ModelsDevOffer[] = [], notes: string[] = [], skipped: Skip[] = [];
  for (const [id, m] of Object.entries(catalog.models))
    if (m.release_date && !releaseDate(m.release_date)) notes.push(`models/${id}: 不正なリリース日 ${m.release_date}`);
  const counts: Record<string, number> = { models: Object.keys(catalog.models).length };
  for (const [providerId, platform] of Object.entries(PROVIDERS)) {
    const entries = catalog.providers[providerId]?.models ?? {};
    counts[providerId] = Object.keys(entries).length;
    for (const [id, m] of Object.entries(entries)) {
      const label = `${providerId}/${id}`;
      if (m.release_date && !releaseDate(m.release_date)) notes.push(`${label}: 不正なリリース日 ${m.release_date}`);
      const parsed = parseKey(id, platform);
      if (!parsed) { notes.push(`${label}: モデルIDを解析できない`); continue; }
      const canonicalModelId = m.canonical_model_id ??
        (catalog.models[`${providerId}/${id}`] ? `${providerId}/${id}` : undefined);
      if (canonicalModelId && !catalog.models[canonicalModelId]) notes.push(`${label}: canonical参照先なし ${canonicalModelId}`);
      const textOnly = m.modalities?.output.length === 1 && m.modalities.output[0] === "text";
      const rules: PriceRule[] = [];
      if (m.cost && textOnly) {
        const rule = (c: { input: number; output: number; cache_read?: number; cache_write?: number }, minPromptTokens: number): PriceRule => ({
          tier: "standard", minPromptTokens, input: c.input, output: c.output,
          ...(c.cache_read !== undefined ? { cacheRead: c.cache_read } : {}),
          ...(c.cache_write !== undefined ? { cacheWrite: c.cache_write } : {}),
        });
        rules.push(rule(m.cost, 0));
        for (const t of m.cost.tiers ?? []) rules.push(rule(t, t.tier.size));
        if (!m.cost.tiers?.length && m.cost.context_over_200k)
          skipped.push({ reason: "context_over_200k の正確な境界が不明なため価格採用を保留", item: label });
        for (const field of Object.keys(m.cost))
          if (!["input", "output", "cache_read", "cache_write", "tiers", "context_over_200k"].includes(field))
            skipped.push({ reason: "未対応の料金項目", item: `${label}: cost.${field}` });
        for (const t of m.cost.tiers ?? []) for (const field of Object.keys(t))
          if (!["input", "output", "cache_read", "cache_write", "tier"].includes(field))
            skipped.push({ reason: "未対応の長文料金項目", item: `${label}: cost.tiers[${t.tier.size}].${field}` });
      } else if (m.cost) skipped.push({ reason: "汎用costの出力モダリティがtext単独ではないため価格採用を保留", item: label });
      for (const mode of Object.keys(m.experimental?.modes ?? {}))
        skipped.push({ reason: "未対応のサービスモード(LiteLLMの既存料金を維持)", item: `${label}: ${mode}` });
      rules.sort((a, b) => a.minPromptTokens - b.minPromptTokens);
      offers.push({ providerId, modelId: id, platform, appId: modelId(parsed.family, platform, parsed.region), canonicalModelId,
        commonReleaseDate: canonicalModelId ? catalog.models[canonicalModelId]?.release_date : undefined, model: m, rules, textOnly,
        url: MODELS_DEV_URL });
    }
  }
  return { catalog, offers, notes, skipped, counts };
}
