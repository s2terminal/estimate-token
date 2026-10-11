import { readFileSync } from "node:fs";
import type { PriceData } from "../shared/types.ts";
import { loadCatalog } from "../pipeline/config.ts";
import type { OpenRouterModel } from "../pipeline/crosscheck.ts";
import { normalize } from "../pipeline/normalize.ts";
import { type LiteLLMData, select } from "../pipeline/select.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
export const litellmSample = (): LiteLLMData => fixture("litellm-sample.json");
export const openrouterSample = (): OpenRouterModel[] => fixture("openrouter-sample.json").data;

export const TODAY = "2026-10-11";

/** フィクスチャから公開データを組み立てる */
export function sampleData(): PriceData {
  const { models } = normalize(select(litellmSample(), loadCatalog(), TODAY), loadCatalog());
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
