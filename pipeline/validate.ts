import type { Model, PriceData, PriceRule } from "../shared/types.ts";
import type { Gates } from "./config.ts";

const PLATFORMS = ["openai", "anthropic", "gemini-api", "vertex-ai", "bedrock", "azure"];
const TIERS = ["standard", "batch", "flex", "priority"];
const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "perImage", "imageOutput"] as const;

/** 出力データの構造チェック(JSON Schema 相当の最低限) */
export function validateSchema(d: PriceData): string[] {
  const errs: string[] = [];
  if (d.schemaVersion !== 1) errs.push("schemaVersion が 1 ではない");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.snapshot)) errs.push("snapshot が日付ではない");
  if (!(d.sources?.fx?.rate > 0)) errs.push("為替レートが正の数ではない");
  if (!Array.isArray(d.models) || !d.models.length) errs.push("models が空");
  const ids = new Set<string>();
  for (const m of d.models ?? []) {
    const where = `モデル ${m.id}`;
    if (ids.has(m.id)) errs.push(`${where}: id が重複`);
    ids.add(m.id);
    if (m.id !== `${m.family}@${m.platform}:${m.region}`) errs.push(`${where}: id の形が不正`);
    if (!PLATFORMS.includes(m.platform)) errs.push(`${where}: platform が不正`);
    if (m.category !== "llm" && m.category !== "image") errs.push(`${where}: category が不正`);
    if (!m.name || !m.vendor) errs.push(`${where}: name / vendor が空`);
    if (!Array.isArray(m.prices)) errs.push(`${where}: prices がない`);
    for (const r of m.prices ?? []) {
      if (!TIERS.includes(r.tier)) errs.push(`${where}: tier が不正`);
      if (!(r.minPromptTokens >= 0)) errs.push(`${where}: minPromptTokens が不正`);
      const vals: unknown[] = PRICE_FIELDS.map((f) => r[f]).concat(Object.values(r.perImageByRes ?? {}));
      for (const v of vals) if (v != null && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) errs.push(`${where}: 単価が負またはNaN`);
    }
  }
  return errs;
}

export interface GateResult {
  /** 1つでもあれば公開を止める */
  stop: string[];
  /** 公開するが Issue に記録する */
  notes: string[];
}

const ruleKey = (r: PriceRule) => `${r.tier}|${r.minPromptTokens}`;
const changePct = (a: number, b: number) => ((b - a) / a) * 100;

/** 前回の公開データと比べて品質ゲートを判定する */
export function evaluateGates(prev: PriceData | null, next: PriceData, gates: Gates): GateResult {
  const stop = validateSchema(next).map((e) => `スキーマ検証: ${e}`);
  const notes: string[] = [];
  if (!prev) return { stop, notes };

  for (const src of ["litellm", "openrouter"] as const) {
    const a = prev.sources[src].bytes, b = next.sources[src].bytes;
    if (a && b != null && b < a * gates.fetch.minSizeRatio) stop.push(`取得失敗: ${src} のサイズが前回の${Math.round((b / a) * 100)}%`);
  }

  const prevCount = prev.models.length, nextCount = next.models.length;
  if (prevCount && ((prevCount - nextCount) / prevCount) * 100 >= gates.count.maxDropPct)
    stop.push(`件数の急減: ${prevCount} → ${nextCount}`);

  const nextById = new Map(next.models.map((m) => [m.id, m]));
  for (const pm of prev.models) {
    const nm = nextById.get(pm.id);
    if (!nm) continue;
    const rules = new Map(nm.prices.map((r) => [ruleKey(r), r]));
    for (const pr of pm.prices) {
      const nr = rules.get(ruleKey(pr));
      for (const f of ["input", "output", "perImage", "imageOutput"] as const) {
        const a = pr[f];
        if (!(a && a > 0)) continue;
        const b = nr?.[f];
        const label = `${pm.id} ${pr.tier}${pr.minPromptTokens ? `(>${pr.minPromptTokens / 1000}K)` : ""} ${f}`;
        if (!b) {
          stop.push(`単価が0になった: ${label} ${a} → ${b ?? "欠落"}`);
          continue;
        }
        const c = changePct(a, b);
        if (Math.abs(c) > gates.price.stopChangePct) stop.push(`大きな値変わり: ${label} ${a} → ${b}(${fmtPct(c)})`);
        else if (Math.abs(c) >= gates.price.noteChangePct) notes.push(`値変わり: ${label} ${a} → ${b}(${fmtPct(c)})`);
      }
    }
  }
  return { stop, notes };
}

export const fmtPct = (c: number) => `${c > 0 ? "+" : ""}${Math.round(c * 10) / 10}%`;

/** 為替の異常判定。異常なら前回値を返す */
export function checkFx(prevRate: number | undefined, rate: number | undefined, gates: Gates): { ok: boolean; reason?: string } {
  if (!(rate && rate > 0)) return { ok: false, reason: "為替の取得に失敗" };
  if (prevRate && Math.abs(changePct(prevRate, rate)) > gates.fx.maxChangePct)
    return { ok: false, reason: `為替の変化が大きい: ${prevRate} → ${rate}` };
  return { ok: true };
}

export type { Model };
