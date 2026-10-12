import { readFileSync } from "node:fs";
import type { Model, PriceData } from "../../shared/types.ts";
import { loadCatalog } from "../../pipeline/config.ts";
import type { OpenRouterModel } from "../../pipeline/crosscheck.ts";
import { normalize } from "../../pipeline/normalize.ts";
import { type LiteLLMData, select } from "../../pipeline/select.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
export const litellmSample = (): LiteLLMData => ({ ...fixture("litellm-sample.json"), ...fixture("openai-image-sample.json"), ...fixture("gemini-image-sample.json") });
export const openrouterSample = (): OpenRouterModel[] => fixture("openrouter-sample.json").data;

export const TODAY = "2026-10-11";

/** フィクスチャから公開データを組み立てる */
function buildSampleData(): PriceData {
  const catalog = loadCatalog();
  const { models } = normalize(select(litellmSample(), catalog, TODAY), catalog);
  for (const m of models) m.firstSeen = TODAY;
  return {
    schemaVersion: 1,
    snapshot: TODAY,
    generatedAt: `${TODAY}T00:00:00Z`,
    baseline: TODAY,
    sources: {
      litellm: { commit: "test", fetchedAt: "", bytes: 100_000 },
      openrouter: { fetchedAt: "", bytes: 10_000 },
      fx: { pair: "USDJPY", rate: 158.25, date: "2026-10-09" },
    },
    models,
  };
}

let sample: PriceData | undefined;
const baseline = () => sample ??= buildSampleData();

/** 呼び出しごとに独立したデータを返し、変更を他のテストに持ち越さない。 */
export const sampleData = (): PriceData => structuredClone(baseline());

export function findModel(models: Model[], id: string): Model {
  const model = models.find((m) => m.id === id);
  if (!model) throw new Error(`テスト用モデルが見つかりません: ${id}`);
  return model;
}

export const sampleModel = (id: string): Model => structuredClone(findModel(baseline().models, id));
