import type { Category, Model, Platform, PriceRule, Tier } from "../shared/types.ts";
import type { Catalog } from "./config.ts";
import type { LiteLLMEntry } from "./select.ts";

/** USD/token → USD/1M tokens。浮動小数点の誤差を消すため有効数字6桁で丸める */
export const perMillion = (v: number): number => Number((v * 1e6).toPrecision(6));
export const round6 = (v: number): number => Number(v.toPrecision(6));

const BEDROCK_PREFIX_REGIONS = ["global", "us", "eu", "jp", "au", "apac", "us-gov", "ca", "apne"];
const AZURE_ZONES = ["us", "eu", "apac", "global", "us-gov"];
const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

export interface ParsedKey {
  family: string;
  region: string;
  /** 日付付きの別名なら true */
  dated: boolean;
  /** Bedrock の `anthropic.` のような開発元の接頭辞 */
  vendorHint?: string;
}

/** キーの形から系列とリージョンを切り出す。対象外の形なら null */
export function parseKey(key: string, platform: Platform): ParsedKey | null {
  let rest = key.replace(/@[\w.-]+$/, ""); // vertex の @default など
  let region = "global";
  let vendorHint: string | undefined;

  switch (platform) {
    case "openai":
    case "anthropic":
      if (rest.includes("/")) return null;
      break;
    case "gemini-api":
      if (!rest.startsWith("gemini/")) return null;
      rest = rest.slice("gemini/".length);
      break;
    case "vertex-ai": {
      rest = rest.replace(/^vertex_ai\//, "");
      const seg = rest.split("/"); // vertex_ai/meta/llama-... のようなパートナーモデル
      if (seg.length === 2) {
        vendorHint = seg[0].replace(/^mistralai$/, "mistral").replace(/-ai$/, "");
        rest = seg[1].replace(/-maas$/, "");
      }
      break;
    }
    case "azure": {
      rest = rest.replace(/^azure(_ai)?\//, "");
      const seg = rest.split("/");
      if (seg.length === 2 && AZURE_ZONES.includes(seg[0])) {
        region = seg[0];
        rest = seg[1];
      }
      break;
    }
    case "bedrock": {
      rest = rest.replace(/^bedrock(_converse)?\//, "");
      region = "regional";
      const seg = rest.split("/");
      if (seg.length === 2 && /^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(seg[0])) {
        region = seg[0];
        rest = seg[1];
      }
      const m = rest.match(new RegExp(`^(${BEDROCK_PREFIX_REGIONS.join("|")})\\.(.+)$`));
      if (m && m[2].includes(".")) {
        region = m[1];
        rest = m[2];
      }
      const v = rest.match(/^([a-z0-9-]+)\.(.+)$/);
      if (v) {
        vendorHint = v[1];
        rest = v[2];
      }
      rest = rest.replace(/(-v\d+)?(:\d+)?$/, "");
      break;
    }
  }
  if (!rest || rest.includes("/")) return null;
  const dated = DATE_SUFFIX.test(rest);
  const family = rest.replace(DATE_SUFFIX, "").toLowerCase();
  return { family, region, dated, vendorHint };
}

export const modelId = (family: string, platform: Platform, region: string): string =>
  `${family}@${platform}:${region}`;

const COST_KEY =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(_above_1hr)?(?:_above_(\d+)k_tokens)?(?:_(batches|flex|priority))?$/;
const TIER_OF: Record<string, Tier> = { batches: "batch", flex: "flex", priority: "priority" };
const TIER_ORDER: Tier[] = ["standard", "batch", "flex", "priority"];

/** LiteLLM エントリから価格ルールを作る */
export function buildRules(e: LiteLLMEntry, category: Category): PriceRule[] {
  if (category === "image") {
    const rule: PriceRule = { tier: "standard", minPromptTokens: 0 };
    if (typeof e.output_cost_per_image === "number") rule.perImage = round6(e.output_cost_per_image);
    const byRes: Record<string, number> = {};
    for (const [k, v] of Object.entries(e)) {
      const m = k.match(/^output_cost_per_image_(\d+(?:\.\d+)?K)$/);
      if (m && typeof v === "number") byRes[m[1]] = round6(v);
    }
    if (Object.keys(byRes).length) rule.perImageByRes = byRes;
    // 既存の1枚単価を優先。両方を持つGeminiなどにOpenAIの換算を適用しない。
    if (rule.perImage == null && !rule.perImageByRes && typeof e.output_cost_per_image_token === "number")
      rule.imageOutput = perMillion(e.output_cost_per_image_token);
    return rule.perImage != null || rule.perImageByRes || rule.imageOutput != null ? [rule] : [];
  }

  const rules = new Map<string, PriceRule>();
  for (const [k, v] of Object.entries(e)) {
    const m = k.match(COST_KEY);
    if (!m || typeof v !== "number" || !Number.isFinite(v)) continue;
    const [, base, oneHour, kTokens, tierKey] = m;
    const tier: Tier = tierKey ? TIER_OF[tierKey] : "standard";
    const minPromptTokens = kTokens ? Number(kTokens) * 1000 : 0;
    const id = `${tier}|${minPromptTokens}`;
    const rule = rules.get(id) ?? { tier, minPromptTokens };
    const price = perMillion(v);
    if (base === "input_cost_per_token") rule.input = price;
    else if (base === "output_cost_per_token") rule.output = price;
    else if (base === "cache_read_input_token_cost") rule.cacheRead = price;
    else rule[oneHour ? "cacheWrite1h" : "cacheWrite"] = price;
    rules.set(id, rule);
  }
  return [...rules.values()]
    .filter((r) => r.input != null || r.output != null)
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.minPromptTokens - b.minPromptTokens);
}

/** 系列名から表示名を作る。例: claude-sonnet-5-5 → Claude Sonnet 5.5、gpt-6.1-sol → GPT-6.1 Sol */
export function displayName(family: string, names: Record<string, string> = {}): string {
  if (names[family]) return names[family];
  const tokens = family.split("-");
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d+(\.\d+)?$/.test(t)) {
      const prev = out[out.length - 1];
      if (prev === "GPT") out[out.length - 1] = `GPT-${t}`;
      else if (i > 0 && /^\d+(\.\d+)?$/.test(tokens[i - 1]) && !tokens[i - 1].includes(".")) out[out.length - 1] += `.${t}`;
      else out.push(t);
    } else if (t === "gpt") out.push("GPT");
    else if (/^o\d/.test(t)) out.push(t);
    else out.push(t.charAt(0).toUpperCase() + t.slice(1));
  }
  return out.join(" ");
}

export function vendorOf(family: string, catalog: Catalog, hint?: string, provider?: string): string {
  for (const v of catalog.vendors) if (new RegExp(v.pattern).test(family)) return v.vendor;
  if (hint) return hint.charAt(0).toUpperCase() + hint.slice(1);
  const m = provider?.match(/^vertex_ai-(\w+?)_models$/);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return "その他";
}

/** 選別済みエントリを正規化スキーマのモデルにまとめる */
export function normalize(entries: [string, LiteLLMEntry][], catalog: Catalog): { models: Model[]; unparsed: string[] } {
  const providerOrder = Object.keys(catalog.providers);
  const unparsed: string[] = [];
  type Cand = { key: string; e: LiteLLMEntry; parsed: ParsedKey; platform: Platform; category: Category; rules: PriceRule[] };
  const groups = new Map<string, Cand[]>();

  for (const [key, e] of entries) {
    const platform = catalog.providers[e.litellm_provider!];
    const parsed = parseKey(key, platform);
    if (!parsed) {
      unparsed.push(key);
      continue;
    }
    const category: Category = e.mode === "image_generation" ? "image" : "llm";
    const rules = buildRules(e, category);
    if (!rules.length) continue;
    const id = modelId(parsed.family, platform, parsed.region);
    const list = groups.get(id) ?? [];
    list.push({ key, e, parsed, platform, category, rules });
    groups.set(id, list);
  }

  const featured = new Set(catalog.featured);
  const models: Model[] = [];
  for (const [id, cands] of groups) {
    // 代表: 日付なし → provider の優先順 → 価格項目が多い → キーが短い
    cands.sort(
      (a, b) =>
        Number(a.parsed.dated) - Number(b.parsed.dated) ||
        providerOrder.indexOf(a.e.litellm_provider!) - providerOrder.indexOf(b.e.litellm_provider!) ||
        b.rules.length - a.rules.length ||
        a.key.length - b.key.length,
    );
    const main = cands[0];
    const aliases = cands.slice(1).map((c) => c.key);
    const { family, region, vendorHint } = main.parsed;
    const m: Model = {
      id,
      family,
      name: displayName(family, catalog.names),
      vendor: vendorOf(family, catalog, vendorHint, main.e.litellm_provider),
      platform: main.platform,
      region,
      category: main.category,
      firstSeen: "",
      status: "active",
      prices: main.rules,
      sources: [{ litellm: main.key, ...(aliases.length ? { aliases } : {}), ...(typeof main.e.source === "string" ? { url: main.e.source } : {}) }],
    };
    if (typeof main.e.max_input_tokens === "number") m.contextWindow = main.e.max_input_tokens;
    if (main.e.deprecation_date) m.deprecationDate = main.e.deprecation_date;
    if (featured.has(id)) m.featured = true;
    models.push(m);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, unparsed };
}
