import type { Model, Platform } from "../shared/types.ts";

export interface OpenRouterModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  expiration_date?: string | null;
  architecture?: { output_modalities?: string[] };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    image_output?: string;
    overrides?: { min_prompt_tokens: number; prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string }[];
  };
}

/* OpenRouter の利用規約(第7条・第12条)は、サイトやAPIの情報のコピー・譲渡を禁じている。
   そのため OpenRouter のデータは検知と照合にだけ使い、値・id・差異%は公開データにも記録にも出さない。 */

/** 直販プラットフォームと OpenRouter のベンダー接頭辞 */
const DIRECT: Partial<Record<Platform, string>> = { openai: "openai", anthropic: "anthropic", "gemini-api": "google" };
const PLATFORM_OF: Record<string, Platform> = { openai: "openai", anthropic: "anthropic", google: "gemini-api" };

/** 名前の比較用キー。claude-sonnet-5.5 と claude-sonnet-5-5 を同じに扱う */
export const cmpKey = (s: string): string => s.toLowerCase().replace(/\./g, "-");

const num = (s?: string): number | undefined => {
  if (s == null || s === "") return undefined;
  const v = Number(s);
  return Number.isFinite(v) && v >= 0 ? v * 1e6 : undefined;
};

const pct = (lit?: number, or?: number): number | undefined => (lit && or != null ? ((or - lit) / lit) * 100 : undefined);

export interface CrossCheckResult {
  /** LiteLLM と OpenRouter の差がしきい値を超えた直販モデルの id(差の値は持たない) */
  mismatches: string[];
  /** OpenRouter にだけある主要ベンダーの新しいモデル(LiteLLM 側の系列名の形で) */
  candidates: { family: string; platform: Platform }[];
}

/**
 * 直販モデルを OpenRouter の同名モデルと突き合わせ、差が大きいものに needsReview を付ける。
 * OpenRouter にだけある主要ベンダーの新しいモデルは、名前だけを候補として返す(公開データには入れない)。
 */
export function crossCheck(
  models: Model[],
  orModels: OpenRouterModel[],
  opts: { mismatchPct: number; recentDays: number; now: Date },
): CrossCheckResult {
  const orMap = new Map<string, OpenRouterModel>();
  for (const m of orModels) {
    if (m.id.includes(":")) continue; // :batch / :free などの派生は使わない
    const [vendor, slug] = m.id.split("/");
    if (!slug || !(vendor in PLATFORM_OF)) continue;
    orMap.set(`${vendor}|${cmpKey(slug)}`, m);
  }

  const matched = new Set<string>();
  const mismatches: string[] = [];
  for (const m of models) {
    const vendor = DIRECT[m.platform];
    if (!vendor || m.category !== "llm") continue;
    const key = `${vendor}|${cmpKey(m.family)}`;
    const or = orMap.get(key);
    if (!or) continue;
    matched.add(key);
    const base = m.prices.find((r) => r.tier === "standard" && r.minPromptTokens === 0);
    const diffs = [pct(base?.input, num(or.pricing?.prompt)), pct(base?.output, num(or.pricing?.completion))];
    if (diffs.some((d) => d != null && Math.abs(d) > opts.mismatchPct)) {
      m.needsReview = true;
      mismatches.push(m.id);
    }
  }

  const candidates: CrossCheckResult["candidates"] = [];
  const knownFamilies = new Set(models.map((m) => `${m.platform}|${cmpKey(m.family)}`));
  const since = opts.now.getTime() / 1000 - opts.recentDays * 86400;
  for (const [key, or] of orMap) {
    if (matched.has(key) || (or.created ?? 0) < since) continue;
    if (!(or.architecture?.output_modalities ?? ["text"]).includes("text")) continue;
    const [vendor, slug] = or.id.split("/");
    const platform = PLATFORM_OF[vendor];
    if (knownFamilies.has(`${platform}|${cmpKey(slug)}`)) continue;
    candidates.push({ family: vendor === "anthropic" ? cmpKey(slug) : slug.toLowerCase(), platform });
  }
  candidates.sort((a, b) => a.family.localeCompare(b.family));
  return { mismatches, candidates };
}
