import { validateCatalog, type CatalogModel, type ModelsDevCatalog } from "../../pipeline/models-dev.ts";

/** APIスキーマの境界条件用の合成データ。ライブfixtureとは区別する。 */
export const offering = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id, name: id, release_date: "2026-09-29", modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1050000, input: 922000, output: 128000 },
  cost: { input: 2, output: 10, cache_read: 0.1, tiers: [
    { input: 4, output: 15, tier: { type: "context", size: 272000 } },
  ], context_over_200k: { input: 4, output: 15 } }, ...extra,
});
export function catalogOf(providers: Record<string, CatalogModel[]>, common: Record<string, CatalogModel> = {}): ModelsDevCatalog {
  return validateCatalog({
    models: { "openai/gpt-6.1-sol": { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", release_date: "2026-09-29" }, ...common },
    providers: Object.fromEntries(Object.entries(providers).map(([id, models]) => [id, { id, models: Object.fromEntries(models.map(m => [m.id, m])) }])),
  });
}
