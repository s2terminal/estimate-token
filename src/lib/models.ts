/* モデルの表示用の補助と、検索・絞り込み */
import { type Model, PLATFORM_LABEL, type PriceData, REGION_LABEL } from "../../shared/types.ts";
import type { Flag } from "./calc.ts";
import type { Tab } from "./state.ts";

export const NEW_DAYS = 14;

export const categoryOf = (t: Tab) => (t === "img" ? "image" : "llm");
export const regionLabel = (r: string) => REGION_LABEL[r] ?? r;
export const where = (m: Model) => [PLATFORM_LABEL[m.platform], regionLabel(m.region)].filter(Boolean).join(" · ");

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400_000;

/** 初回取り込み後に入り、firstSeen から14日以内のモデル */
export const isNew = (m: Model, d: PriceData) => m.firstSeen > d.baseline && daysBetween(m.firstSeen, d.snapshot) <= NEW_DAYS;

/** モデルそのものに付く注記(新着・要確認) */
export function modelFlags(m: Model, d: PriceData): Flag[] {
  const f: Flag[] = [];
  if (isNew(m, d)) f.push({ t: "新着", k: "promo" });
  if (m.needsReview) f.push({ t: "要確認(別ソースと価格に差)", k: "warn" });
  return f;
}

export interface Filter {
  q: string;
  vendor: string;
  platform: string;
  region: string;
}

export const isFiltering = (f: Filter) => !!(f.q.trim() || f.vendor || f.platform || f.region);

/**
 * モデル一覧に出すモデル。絞り込みなしなら featured・新着・選択中だけ、
 * 検索や絞り込みがあれば条件に合うものすべて。
 */
export function visibleModels(models: Model[], d: PriceData, f: Filter, selected: Set<string>): Model[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((m) => {
    if (!isFiltering(f)) return m.featured || selected.has(m.id) || isNew(m, d);
    if (f.vendor && m.vendor !== f.vendor) return false;
    if (f.platform && m.platform !== f.platform) return false;
    if (f.region && m.region !== f.region) return false;
    const hay = `${m.name} ${m.family} ${m.vendor} ${where(m)} ${m.id}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
