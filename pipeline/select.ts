import type { Catalog } from "./config.ts";

/** LiteLLM の1エントリ(必要な項目だけ型を付ける) */
export interface LiteLLMEntry {
  litellm_provider?: string;
  mode?: string;
  max_input_tokens?: number;
  deprecation_date?: string;
  source?: string;
  [k: string]: unknown;
}
export type LiteLLMData = Record<string, LiteLLMEntry>;

/** catalog.yaml の規則で対象エントリを選ぶ。today は YYYY-MM-DD */
export function select(data: LiteLLMData, catalog: Catalog, today: string): [string, LiteLLMEntry][] {
  const excludes = catalog.excludeKeyPatterns.map((p) => new RegExp(p, "i"));
  return Object.entries(data).filter(([key, e]) => {
    if (key === "sample_spec" || !e || typeof e !== "object") return false;
    if (!e.litellm_provider || !(e.litellm_provider in catalog.providers)) return false;
    if (!e.mode || !catalog.modes.includes(e.mode)) return false;
    if (e.deprecation_date && e.deprecation_date < today) return false;
    if (excludes.some((re) => re.test(key))) return false;
    return true;
  });
}
