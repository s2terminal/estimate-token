/* 月額の計算ロジック。画面から独立した純粋関数にしてテストする */
import type { Model, PriceRule, Tier } from "../../shared/types.ts";
import { estimateImageTokens, type ImageQuality } from "./image-tokens.ts";

export interface Flag {
  t: string;
  k: "" | "warn" | "promo";
}

export interface LlmUsage {
  /** 回/月 */
  n: number;
  /** 平均入力 tokens/回 */
  i: number;
  /** 平均出力 tokens/回 */
  o: number;
  /** キャッシュを考慮するか */
  c: boolean;
  /** キャッシュヒット率 % */
  h: number;
  tier: Tier;
}

export interface ImageUsage {
  /** 枚/月 */
  n: number;
  /** 解像度 */
  r: string;
  /** トークン課金モデルの幅・高さ(px)と画質。旧リンクは1024×1024、medium */
  w?: number;
  h?: number;
  q?: ImageQuality;
}

export interface PriceOptions {
  /** 試算基準日(期間限定価格の判定日) */
  asOf: string;
  /** 期間限定価格を適用するか */
  promo: boolean;
}

export type PartKey = "in" | "cache" | "out" | "total";
export interface Part {
  k: PartKey;
  v: number;
}

export interface CalcOk {
  na: false;
  m: Model;
  usd: number;
  rule: PriceRule;
  pin?: number;
  pout?: number;
  pcin?: number;
  perImage?: number;
  imageTokens?: number;
  flags: Flag[];
  parts: Part[];
}
export interface CalcNa {
  na: true;
  m: Model;
  why: string;
  flags: Flag[];
}
export type CalcResult = CalcOk | CalcNa;

export const TIER_LABEL: Record<Tier, string> = { standard: "Standard", batch: "Batch", flex: "Flex", priority: "Priority" };

const inRange = (r: PriceRule, d: string) => (!r.validFrom || r.validFrom <= d) && (!r.validTo || d <= r.validTo);

/**
 * 価格ルールを選ぶ。
 * 1. 料金プランで絞る(ないときは standard にして注記)
 * 2. 期間限定価格の有効期間で絞る
 * 3. 入力tokensが minPromptTokens を超えるルールのうち、最大の minPromptTokens を持つもの(長文価格)
 */
export function pickRule(
  prices: PriceRule[],
  tier: Tier,
  promptTokens: number,
  opts: PriceOptions = { asOf: "9999-12-31", promo: true },
): { rule: PriceRule | null; flags: Flag[]; why?: string } {
  const flags: Flag[] = [];
  let cands = prices.filter((r) => r.tier === tier);
  if (!cands.length && tier !== "standard") {
    cands = prices.filter((r) => r.tier === "standard");
    if (cands.length) flags.push({ t: `${TIER_LABEL[tier]}なし→Standard`, k: "warn" });
  }
  if (!cands.length) return { rule: null, flags, why: "価格未取得" };

  cands = cands.filter((r) => inRange(r, opts.asOf) && (opts.promo || !r.promo));
  if (!cands.length) return { rule: null, flags, why: "基準日に有効な価格なし" };

  const fit = cands.filter((r) => r.minPromptTokens === 0 || promptTokens > r.minPromptTokens);
  const rule = fit.sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0] ?? null;
  if (!rule) return { rule: null, flags, why: "価格未取得" };
  if (rule.minPromptTokens > 0) flags.push({ t: `長文価格(>${rule.minPromptTokens / 1000}K)`, k: "warn" });
  if (rule.promo && rule.validTo) flags.push({ t: `期間限定 〜${rule.validTo.slice(5).replace("-", "/")}`, k: "promo" });
  return { rule, flags };
}

/** 言語モデルの月額(USD) */
export function calcLlm(m: Model, u: LlmUsage, opts?: PriceOptions): CalcResult {
  const pk = pickRule(m.prices, u.tier, u.i, opts);
  if (!pk.rule) return { na: true, m, why: pk.why ?? "価格未取得", flags: pk.flags };
  const r = pk.rule;
  const flags = [...pk.flags];
  if (r.input == null || r.output == null) return { na: true, m, why: "入力または出力の単価が未取得", flags };
  let cached = 0;
  if (u.c && u.h > 0) {
    if (r.cacheRead != null) cached = (u.i * Math.min(100, u.h)) / 100;
    else flags.push({ t: "キャッシュ単価なし", k: "warn" });
  }
  const ui = (u.n * (u.i - cached) * r.input) / 1e6;
  const uc = (u.n * cached * (r.cacheRead ?? 0)) / 1e6;
  const uo = (u.n * u.o * r.output) / 1e6;
  return {
    na: false,
    m,
    usd: ui + uc + uo,
    rule: r,
    pin: r.input,
    pout: r.output,
    pcin: r.cacheRead,
    flags,
    parts: [
      { k: "in", v: ui },
      { k: "cache", v: uc },
      { k: "out", v: uo },
    ],
  };
}

/** 画像生成の月額(USD)。画像出力トークン課金、または解像度別単価 → perImage */
export function calcImage(m: Model, u: ImageUsage): CalcResult {
  const rule = m.prices.find((r) => r.tier === "standard" && r.minPromptTokens === 0) ?? m.prices[0];
  if (!rule) return { na: true, m, why: "価格未取得", flags: [] };
  const flags: Flag[] = [];
  if (rule.imageOutput != null && rule.perImage == null && !rule.perImageByRes) {
    const w = u.w ?? 1024, h = u.h ?? 1024, q = u.q ?? "medium";
    const estimate = estimateImageTokens(m.family, w, h, q);
    if (estimate.tokens == null) return { na: true, m, why: estimate.why, flags };
    const p = estimate.tokens * rule.imageOutput / 1e6;
    flags.push({ t: `概算 ${estimate.tokens} 画像tokens/枚(${w}×${h}・${q})`, k: "" });
    flags.push({ t: "画像出力のみ(入力・部分画像は別料金)", k: "warn" });
    if (Math.max(w, h) > 2560 || w * h > 2560 * 1440)
      flags.push({ t: "高解像度は実験的対応", k: "warn" });
    return { na: false, m, usd: u.n * p, rule, perImage: p, imageTokens: estimate.tokens, flags, parts: [{ k: "total", v: u.n * p }] };
  }
  let p = rule.perImageByRes?.[u.r];
  if (p == null && rule.perImage != null) {
    p = rule.perImage;
    if (rule.perImageByRes) flags.push({ t: `${u.r}の価格なし→共通単価`, k: "warn" });
  }
  if (p == null) return { na: true, m, why: rule.perImageByRes ? `${u.r}の価格未取得` : "1枚あたりの価格未取得", flags };
  const usd = u.n * p;
  return { na: false, m, usd, rule, perImage: p, flags, parts: [{ k: "total", v: usd }] };
}
