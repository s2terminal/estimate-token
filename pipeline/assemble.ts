import type { PriceData } from "../shared/types.ts";
import type { Catalog } from "./config.ts";
import type { FetchResult } from "./fetch.ts";
import { mergeModels, type ModelsDevPolicy } from "./merge-models.ts";
import { normalizeModelsDev, type Skip } from "./models-dev.ts";
import { normalize } from "./normalize.ts";
import { select } from "./select.ts";

export function assembleModels(src: FetchResult, prev: PriceData | null, catalog: Catalog, policy: ModelsDevPolicy, today: string) {
  if (!src.litellm || (!src.modelsDev && prev?.sources.modelsDev)) {
    if (!prev) throw new Error("LiteLLMの正常スナップショットも前回の公開値もないため更新できません");
    return { models: structuredClone(prev.models), unparsed: [] as string[], frozen: true, skipped: [] as Skip[],
      notes: ["価格ソースの正常rawがないため、前回の公開モデル・価格・採用元を維持"] };
  }
  const normalized = normalize(select(src.litellm.data, catalog, today), catalog, src.litellm.commit);
  if (!src.modelsDev) return { ...normalized, frozen: false, skipped: [] as Skip[], notes: ["models.dev未取得。既存LiteLLMの価格のみを使用"] };
  const blockedOffers = new Set<string>();
  for (const [id, entry] of Object.entries(src.litellm.data)) {
    const platform = entry.litellm_provider && catalog.providers[entry.litellm_provider];
    if (!platform) continue;
    if ((entry.deprecation_date && entry.deprecation_date <= today) || (entry.mode && !catalog.modes.includes(entry.mode))) {
      const sourceId = id.replace(/^(?:gemini|vertex_ai|bedrock_converse|bedrock|azure_ai|azure)\//, "");
      blockedOffers.add(platform + "/" + sourceId);
    }
  }
  const merged = mergeModels(normalized.models, normalizeModelsDev(src.modelsDev.data), policy, catalog, today, { blockedOffers });
  return { models: merged.models, unparsed: normalized.unparsed, frozen: false, notes: merged.notes, skipped: merged.skipped };
}
