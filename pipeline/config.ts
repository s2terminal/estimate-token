import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Category, Platform } from "../shared/types.ts";
import type { ModelsDevPolicy } from "./merge-models.ts";

export interface RecommendationGroup {
  category: Category;
  vendor: string;
  /** 用途が同じモデル系列にだけ一致する正規表現 */
  pattern: string;
}

export interface Catalog {
  providers: Record<string, Platform>;
  modes: string[];
  excludeKeyPatterns: string[];
  vendors: { pattern: string; vendor: string }[];
  names: Record<string, string>;
  recommendations: RecommendationGroup[];
}

export interface Gates {
  fetch: { minSizeRatio: number };
  count: { maxDropPct: number };
  price: { stopChangePct: number; noteChangePct: number };
  crosscheck: { mismatchPct: number };
  fx: { maxChangePct: number };
  newModel: { days: number; openrouterRecentDays: number };
  retire: { minAgeMonths: number };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const load = <T>(name: string): T => parse(readFileSync(`${root}config/${name}`, "utf8")) as T;

export const loadCatalog = (): Catalog => load<Catalog>("catalog.yaml");
export const loadGates = (): Gates => load<Gates>("gates.yaml");
export function loadModelsDevPolicy(): ModelsDevPolicy {
  const config = load<ModelsDevPolicy>("models-dev-policy.yaml");
  if (!config || !Array.isArray(config.offers) || !config.metadata || typeof config.metadata !== "object")
    throw new Error("models-dev-policy.yaml のルート構造が不正");
  const ids = new Set<string>();
  for (const offer of config.offers) {
    const id = offer.providerId + "/" + offer.modelId;
    if (ids.has(id) || !["openai", "anthropic", "google"].includes(offer.providerId) ||
        typeof offer.modelId !== "string" || !offer.modelId ||
        !Array.isArray(offer.promptThresholds) || offer.promptThresholds[0] !== 0 ||
        offer.promptThresholds.some((n, i, all) => !Number.isSafeInteger(n) || n < 0 || (i > 0 && n <= all[i-1])) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(offer.checkedAt) ||
        !Array.isArray(offer.references) || !offer.references.length || offer.references.some(url => typeof url !== "string" || !/^https:\/\//.test(url)) ||
        (offer.cacheWriteTtlMinutes !== undefined && offer.cacheWriteTtlMinutes !== 5) ||
        (offer.allowNew !== undefined && typeof offer.allowNew !== "boolean") ||
        (offer.allowPreview !== undefined && typeof offer.allowPreview !== "boolean"))
      throw new Error("models-dev-policy.yaml の確認済み提供条件が不正: " + id);
    ids.add(id);
  }
  for (const canonical of Object.values(config.metadata))
    if (typeof canonical !== "string" || !canonical.includes("/")) throw new Error("models-dev-policy.yaml の共通モデル対応が不正");
  if (config.recommendationPreviews !== undefined && (!Array.isArray(config.recommendationPreviews) || config.recommendationPreviews.some(id => typeof id !== "string")))
    throw new Error("models-dev-policy.yaml のpreview採用設定が不正");
  return config;
}
export const ROOT = root;
