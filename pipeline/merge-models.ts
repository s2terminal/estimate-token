import type { Model, PriceRule, ValueSource } from "../shared/types.ts";
import type { Catalog } from "./config.ts";
import { displayName, parseKey, vendorOf } from "./normalize.ts";
import { MODELS_DEV_URL, type ModelsDevOffer, type NormalizedModelsDev } from "./models-dev.ts";
import { releaseDate, releaseInterval } from "./recommend.ts";

export interface VerifiedOffer {
  providerId: "openai" | "anthropic" | "google";
  modelId: string;
  /** 公式資料で入力長・厳密な超過条件を確認した境界。 */
  promptThresholds: number[];
  checkedAt: string;
  references: string[];
  allowNew?: boolean;
  allowPreview?: boolean;
  /** 汎用cache_writeを5分料金として採用できる場合だけ指定する。 */
  cacheWriteTtlMinutes?: 5;
}
export interface ModelsDevPolicy {
  offers: VerifiedOffer[];
  /** 既存のお勧めで採用を確認済みのpreview。価格採用の許可には使用しない。 */
  recommendationPreviews?: string[];
  /** 価格の照合には使用しない、確認済み共通メタデータの対応。 */
  metadata: Record<string, string>;
}
const FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export const pricesEqual = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, 1e-5 * Math.max(Math.abs(a), Math.abs(b)));
const nativeId = (id: string) => id.replace(/^(?:gemini|vertex_ai|bedrock_converse|bedrock|azure_ai|azure)\//, "");
const ref = (o: ModelsDevOffer): ValueSource => ({ source: "models.dev", providerId: o.providerId, modelId: o.modelId, url: MODELS_DEV_URL });
const rulesConflict = (a: PriceRule[], b: PriceRule[]) => a.some(ar => {
  const br = b.find(r => r.tier === ar.tier && r.minPromptTokens === ar.minPromptTokens);
  return br && FIELDS.some(f => ar[f] !== undefined && br[f] !== undefined && !pricesEqual(ar[f]!, br[f]!));
});
const verified = (o: ModelsDevOffer, policy: ModelsDevPolicy) => policy.offers.find(v => v.providerId === o.providerId && v.modelId === o.modelId);
const current = (o: ModelsDevOffer, today: string) => {
  const date = releaseDate(o.model.release_date);
  return o.model.status !== "deprecated" && o.model.status !== "alpha" && !!date &&
    releaseInterval(date)![1] <= Date.parse(today + "T23:59:59.999Z");
};
function eligible(o: ModelsDevOffer, v: VerifiedOffer | undefined, today: string): v is VerifiedOffer {
  if (!v || !["openai", "anthropic", "google"].includes(o.providerId) || !v.references.length || !releaseDate(v.checkedAt) ||
      v.checkedAt > today || !o.textOnly || !o.rules.length || !current(o, today)) return false;
  if (!o.model.modalities?.input.includes("text") || o.model.cost?.reasoning !== undefined ||
      o.model.cost?.tiers?.some(t => t.reasoning !== undefined)) return false;
  if (o.commonReleaseDate && (!releaseInterval(o.commonReleaseDate) ||
      releaseInterval(o.commonReleaseDate)![1] > Date.parse(today + "T23:59:59.999Z"))) return false;
  if (o.model.provider?.body?.service_tier !== undefined && o.model.provider.body.service_tier !== "default" && o.model.provider.body.service_tier !== "standard") return false;
  if ((o.model.status === "beta" || /preview/i.test(o.modelId)) && !v.allowPreview) return false;
  if (o.model.cost?.context_over_200k && !o.model.cost.tiers?.length) return false;
  return JSON.stringify([...v.promptThresholds].sort((a,b) => a-b)) === JSON.stringify(o.rules.map(r => r.minPromptTokens));
}
function enrich(m: Model, matches: ModelsDevOffer[], data: NormalizedModelsDev, policy: ModelsDevPolicy, notes: string[]) {
  const primary = m.sources.find(s => s.litellm)?.litellm;
  const lab = ({ OpenAI: "openai", Anthropic: "anthropic", Google: "google" } as Record<string, string>)[m.vendor];
  const exact = primary && lab ? `${lab}/${nativeId(primary)}` : "";
  const ids = new Set(matches.map(o => o.canonicalModelId).filter((id): id is string => !!id && !!data.catalog.models[id]));
  const mapped = policy.metadata[m.id];
  if (mapped && !data.catalog.models[mapped]) notes.push(`${m.id}: 確認済み共通モデルの参照先なし ${mapped}`);
  if (mapped && data.catalog.models[mapped]) ids.add(mapped);
  if (exact && data.catalog.models[exact]) ids.add(exact);
  if (ids.size > 1) { notes.push(`${m.id}: canonical参照の競合 ${[...ids].join(", ")}`); return; }
  const canonical = [...ids][0];
  const common = canonical ? data.catalog.models[canonical] : undefined;
  if (canonical) m.canonicalModelId = canonical;
  const date = releaseDate(common?.release_date);
  if (common?.release_date && !date) notes.push(`${m.id}: 共通モデルのリリース日が不正 ${common.release_date}`);
  const providerDates = new Set(matches.map(o => releaseDate(o.model.release_date)).filter((d): d is string => !!d));
  const fallback = providerDates.size === 1 ? [...providerDates][0] : undefined;
  if (providerDates.size > 1 && !date) notes.push(`${m.id}: 提供先のリリース日が競合`);
  const adopted = date ?? fallback;
  if (adopted && (date || !m.releaseDate)) {
    const fallbackOffer = matches.find(o => releaseDate(o.model.release_date) === adopted);
    if (m.releaseDate && m.releaseDate !== adopted) notes.push(`${m.id}: リリース日 ${m.releaseDate} → ${adopted} (共通モデル情報を優先)`);
    m.releaseDate = adopted;
    m.releaseDateSource = { source: "models.dev", modelId: date ? canonical! : fallbackOffer!.modelId,
      ...(date ? {} : { providerId: fallbackOffer!.providerId }), url: MODELS_DEV_URL,
      precision: adopted.length === 7 ? "month" : "day" };
  }
  // 提供条件によって上限が異なるため、共通メタデータの上限は提供先の上限に転用しない。
  if (matches.length === 1) {
    const limit = matches[0].model.limit;
    m.metadataSources ??= {};
    if (limit?.input !== undefined && m.inputLimit === undefined) {
      m.inputLimit = limit.input;
      if (m.contextWindow === undefined) m.contextWindow = limit.input;
      m.metadataSources.inputLimit = ref(matches[0]);
    }
    if (limit?.context !== undefined && m.totalContext === undefined) {
      m.totalContext = limit.context;
      m.metadataSources.totalContext = ref(matches[0]);
    }
    if (limit?.output !== undefined && m.outputLimit === undefined) {
      m.outputLimit = limit.output;
      m.metadataSources.outputLimit = ref(matches[0]);
    }
    if (matches[0].model.modalities) {
      m.modalities = matches[0].model.modalities;
      m.metadataSources.modalities = ref(matches[0]);
    }
    for (const [target, source] of [["reasoning", "reasoning"], ["toolCall", "tool_call"]] as const) {
      const value = matches[0].model[source];
      if (value !== undefined) { m[target] = value; m.metadataSources[target] = ref(matches[0]); }
    }
    m.providerStatus = matches[0].model.status;
    const offer = matches[0], mapping = verified(offer, policy);
    if (["alpha", "deprecated"].includes(offer.model.status ?? "") ||
        ((offer.model.status === "beta" || /preview/i.test(offer.modelId)) && !mapping?.allowPreview && !policy.recommendationPreviews?.includes(m.id)))
      m.recommendationEligible = false;
  }
  if (canonical || matches.length) {
    m.metadataSources ??= {};
    if (matches.some(o => ["alpha", "deprecated"].includes(o.model.status ?? ""))) m.recommendationEligible = false;
    for (const o of matches) if (!m.sources.some(s => s.modelsDev?.providerId === o.providerId && s.modelsDev.modelId === o.modelId))
      m.sources.push({ modelsDev: { providerId: o.providerId, modelId: o.modelId, ...(o.model.status ? { status: o.model.status } : {}) }, url: MODELS_DEV_URL });
  }
}
export function mergeModels(models: Model[], data: NormalizedModelsDev, policy: ModelsDevPolicy, catalog: Catalog, today: string,
  options: { blockedOffers?: Set<string> } = {}): { models: Model[]; notes: string[] } {
  const notes = [...data.notes];
  const byApp = new Map<string, ModelsDevOffer[]>();
  for (const o of data.offers) byApp.set(o.appId, [...(byApp.get(o.appId) ?? []), o]);
  for (const m of models) {
    const key = m.sources.find(s => s.litellm)?.litellm;
    const previous = m.sources.find(s => s.modelsDev)?.modelsDev;
    const matches = (byApp.get(m.id) ?? []).filter(o => key ? nativeId(key) === o.modelId : previous?.providerId === o.providerId && previous.modelId === o.modelId);
    enrich(m, matches, data, policy, notes);
    let conflict = false;
    for (let i = 0; i < matches.length; i++) for (let j = i + 1; j < matches.length; j++) {
      if (rulesConflict(matches[i].rules, matches[j].rules)) {
        conflict = true;
        notes.push(`${m.id}: models.dev内の価格競合 ${matches[i].providerId}/${matches[i].modelId} / ${matches[j].providerId}/${matches[j].modelId}。補完を保留`);
        for (const a of matches[i].rules) {
          const b = matches[j].rules.find(r => r.minPromptTokens === a.minPromptTokens && r.tier === a.tier);
          if (!b) continue;
          for (const f of FIELDS) if (a[f] !== undefined && b[f] !== undefined && !pricesEqual(a[f]!, b[f]!))
            notes.push(`${m.id} ${a.tier} >${a.minPromptTokens} ${f}: ${matches[i].providerId}/${matches[i].modelId}=${a[f]}, ${matches[j].providerId}/${matches[j].modelId}=${b[f]} USD/1M (提供条件の同一性は未確認)`);
        }
      }
    }
    for (const o of matches) {
      const comparable = eligible(o, verified(o, policy), today);
      if (!["openai", "anthropic", "google"].includes(o.providerId))
        notes.push(`${m.id}: ${o.providerId}/${o.modelId} の地域・サービス条件は未確認、価格は自動採用しない`);
      for (const rule of o.rules) {
        const existing = m.prices.find(r => r.tier === "standard" && r.minPromptTokens === rule.minPromptTokens);
        if (!existing) continue;
        for (const field of FIELDS) {
          const a = existing[field], b = rule[field];
          if (a === undefined || b === undefined) continue;
          if (pricesEqual(a, b) && comparable && (field !== "cacheWrite" || verified(o, policy)?.cacheWriteTtlMinutes === 5)) {
            existing.comparedSources ??= {};
            existing.comparedSources[field] ??= [];
            if (!existing.comparedSources[field]!.some(s => s.providerId === o.providerId && s.modelId === o.modelId))
              existing.comparedSources[field]!.push(ref(o));
          } else if (!pricesEqual(a, b)) {
            conflict = true;
            notes.push(`${m.id} standard >${rule.minPromptTokens} ${field}: LiteLLM=${a}, models.dev ${o.providerId}/${o.modelId}=${b} USD/1M。既存値を維持`);
          }
        }
      }
    }
    if (conflict) { m.needsReview = true; continue; }
    for (const o of matches) {
      const v = verified(o, policy);
      if (!eligible(o, v, today) || m.category !== "llm" || m.status !== "active") continue;
      if (m.prices.some(r => r.tier === "standard" && !v.promptThresholds.includes(r.minPromptTokens))) {
        notes.push(`${m.id}: 長文価格ルールの集合が不一致。補完を保留`); continue;
      }
      for (const rule of o.rules) {
        let existing = m.prices.find(r => r.tier === "standard" && r.minPromptTokens === rule.minPromptTokens);
        if (!existing) { existing = { tier: "standard", minPromptTokens: rule.minPromptTokens }; m.prices.push(existing); }
        for (const f of FIELDS) {
          if (f === "cacheWrite" && v.cacheWriteTtlMinutes !== 5) continue;
          if (existing[f] !== undefined || rule[f] === undefined) continue;
          existing[f] = rule[f];
          existing.provenance ??= {};
          existing.provenance[f] = { ...ref(o), references: v.references, checkedAt: v.checkedAt };
          notes.push(`${m.id} standard >${rule.minPromptTokens} ${f}: models.devで補完 (${o.providerId}/${o.modelId})`);
        }
      }
    }
  }
  const ids = new Set(models.map(m => m.id));
  for (const o of data.offers) {
    if (ids.has(o.appId)) continue;
    if (options.blockedOffers?.has(o.platform + "/" + o.modelId)) {
      notes.push(`${o.providerId}/${o.modelId}: LiteLLMで既知の廃止・対象外条件を維持し、新規追加を保留`); continue;
    }
    const v = verified(o, policy);
    if (!v?.allowNew || !eligible(o, v, today) || catalog.excludeKeyPatterns.some(p => new RegExp(p).test(o.modelId))) {
      notes.push(`${o.providerId}/${o.modelId}: 追加候補 (提供条件・公開APIでの利用可能性を未確認)`); continue;
    }
    const group = byApp.get(o.appId) ?? [];
    if (group.some(other => other.modelId !== o.modelId || rulesConflict(o.rules, other.rules))) {
      notes.push(`${o.appId}: 別名・provider競合のため新規追加を保留`); continue;
    }
    const parsed = parseKey(o.modelId, o.platform)!;
    const m: Model = { id: o.appId, family: parsed.family, name: displayName(parsed.family, catalog.names),
      vendor: vendorOf(parsed.family, catalog, parsed.vendorHint), platform: o.platform, region: parsed.region,
      category: "llm", firstSeen: today, status: "active", prices: [], sources: [{ modelsDev: { providerId: o.providerId, modelId: o.modelId }, url: MODELS_DEV_URL }] };
    for (const r of o.rules) {
      const rule: PriceRule = { tier: "standard", minPromptTokens: r.minPromptTokens, provenance: {} };
      for (const f of FIELDS) if (r[f] !== undefined && (f !== "cacheWrite" || v.cacheWriteTtlMinutes === 5)) {
        rule[f] = r[f]; rule.provenance![f] = { ...ref(o), references: v.references, checkedAt: v.checkedAt };
      }
      m.prices.push(rule);
    }
    enrich(m, [o], data, policy, notes);
    models.push(m); ids.add(m.id);
    notes.push(`${m.id}: models.devから確認済みモデルを追加`);
  }
  models.sort((a,b) => a.id.localeCompare(b.id));
  return { models, notes };
}
