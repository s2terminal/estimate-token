import type { Model, PriceData, PriceRule, ValueSource } from "../shared/types.ts";
import type { Gates } from "./config.ts";
import { releaseDate } from "./recommend.ts";

const PLATFORMS = ["openai", "anthropic", "gemini-api", "vertex-ai", "bedrock", "azure"];
const TIERS = ["standard", "batch", "flex", "priority"];
const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "perImage", "imageOutput"] as const;
const validSource = (s: ValueSource) => !!s && ["litellm", "models.dev"].includes(s.source) &&
  typeof s.modelId === "string" && !!s.modelId && typeof s.url === "string" && /^https:\/\//.test(s.url) &&
  (s.providerId === undefined || typeof s.providerId === "string") &&
  (s.checkedAt === undefined || !!releaseDate(s.checkedAt)) &&
  (s.references === undefined || Array.isArray(s.references) && s.references.every(url => typeof url === "string" && /^https:\/\//.test(url)));

export function ruleValues(rule: PriceRule): Record<string, number> {
  const values: Record<string, number> = {};
  for (const field of PRICE_FIELDS) if (rule[field] !== undefined) values[field] = rule[field]!;
  for (const [res, price] of Object.entries(rule.perImageByRes ?? {})) values["perImageByRes." + res] = price;
  return values;
}

/** 出力データの構造チェック(JSON Schema 相当の最低限) */
export function validateSchema(d: PriceData): string[] {
  const errs: string[] = [];
  if (d.schemaVersion !== 1) errs.push("schemaVersion が 1 ではない");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.snapshot)) errs.push("snapshot が日付ではない");
  if (!(d.sources?.fx?.rate > 0)) errs.push("為替レートが正の数ではない");
  const md = d.sources?.modelsDev;
  if (md) {
    if (md.url !== "https://models.dev/catalog.json" || !/^[a-f0-9]{64}$/.test(md.sha256) ||
        !Number.isFinite(md.bytes) || md.bytes <= 0 || !Number.isFinite(Date.parse(md.fetchedAt)) ||
        (md.stale !== undefined && typeof md.stale !== "boolean")) errs.push("models.dev の出典メタ情報が不正");
    for (const count of Object.values(md.counts ?? {})) if (!Number.isSafeInteger(count) || count < 0) errs.push("models.dev の取得件数が不正");
  }
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
    if (m.releaseDate !== undefined && !releaseDate(m.releaseDate)) errs.push(`${where}: releaseDate が不正`);
    if (m.releaseDateSource && (!m.releaseDate || !validSource(m.releaseDateSource) ||
        !["month", "day", "timestamp"].includes(m.releaseDateSource.precision) ||
        (m.releaseDate?.length === 7 ? "month" : m.releaseDate?.length === 10 ? "day" : "timestamp") !== m.releaseDateSource.precision))
      errs.push(`${where}: リリース日の出典・精度が不正`);
    if (m.canonicalModelId !== undefined && (typeof m.canonicalModelId !== "string" || !m.canonicalModelId.includes("/"))) errs.push(`${where}: canonicalModelId が不正`);
    for (const field of ["inputLimit", "totalContext", "outputLimit"] as const)
      if (m[field] !== undefined && (!Number.isFinite(m[field]) || m[field]! < 0)) errs.push(`${where}: ${field} が不正`);
    for (const source of Object.values(m.metadataSources ?? {})) if (source && !validSource(source)) errs.push(`${where}: 仕様の出典が不正`);
    if (m.providerStatus !== undefined && !["alpha", "beta", "deprecated"].includes(m.providerStatus)) errs.push(`${where}: providerStatus が不正`);
    if (m.recommendationEligible !== undefined && typeof m.recommendationEligible !== "boolean") errs.push(`${where}: recommendationEligible が不正`);
    if (!Array.isArray(m.sources)) errs.push(`${where}: sources が不正`);
    for (const source of Array.isArray(m.sources) ? m.sources : []) if (source.modelsDev && (!source.modelsDev.providerId || !source.modelsDev.modelId ||
        (source.modelsDev.status !== undefined && !["alpha", "beta", "deprecated"].includes(source.modelsDev.status))))
      errs.push(`${where}: models.dev 元IDが不正`);
    if (!Array.isArray(m.prices)) errs.push(`${where}: prices がない`);
    for (const r of Array.isArray(m.prices) ? m.prices : []) {
      if (r.source && !d.sources.promotions?.some((s) => s.id === r.source && s.license === "CC-BY-4.0")) errs.push(`${where}: 価格の出典・ライセンスが未取得`);
      for (const day of [r.validFrom, r.validTo]) {
        if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)) errs.push(`${where}: 価格の適用日が不正`);
      }
      if (r.validFrom && r.validTo && r.validFrom > r.validTo) errs.push(`${where}: 価格の適用期間が逆転`);
      if (!TIERS.includes(r.tier)) errs.push(`${where}: tier が不正`);
      if (!Number.isSafeInteger(r.minPromptTokens) || r.minPromptTokens < 0) errs.push(`${where}: minPromptTokens が不正`);
      const vals: unknown[] = PRICE_FIELDS.map((f) => r[f]).concat(Object.values(r.perImageByRes ?? {}));
      for (const v of vals) if (v != null && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) errs.push(`${where}: 単価が負またはNaN`);
      for (const [field, source] of Object.entries(r.provenance ?? {}))
        if (!source || !validSource(source) || r[field as keyof PriceRule] === undefined) errs.push(`${where}: 価格の採用元が不正`);
      for (const sources of Object.values(r.comparedSources ?? {}))
        if (!Array.isArray(sources) || sources.some(s => !validSource(s))) errs.push(`${where}: 価格の照合元が不正`);
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

/** 十分古い(リリースから retire.minAgeMonths 以上)か提供終了のモデル。単価が0・欠落になったら止めずに掲載から外す */
export function isRetiring(m: Model, today: string, gates: Gates): boolean {
  if (m.status === "deprecated" || m.providerStatus === "deprecated" || (m.deprecationDate && m.deprecationDate <= today)) return true;
  if (!m.releaseDate) return false;
  const limit = new Date(`${m.releaseDate.length === 7 ? m.releaseDate + "-01" : m.releaseDate.slice(0, 10)}T00:00:00Z`);
  limit.setUTCMonth(limit.getUTCMonth() + gates.retire.minAgeMonths);
  return limit.toISOString().slice(0, 10) <= today;
}

/** 古い・提供終了モデルで前回は正だった単価が0になった価格ルールを外し、ルールが残らないモデルは掲載から外す */
export function dropZeroedRetiring(prev: PriceData | null, next: PriceData, gates: Gates): string[] {
  const notes: string[] = [];
  const prevById = new Map((prev?.models ?? []).map((m) => [m.id, m]));
  next.models = next.models.filter((nm) => {
    const pm = prevById.get(nm.id);
    if (!pm || !isRetiring(nm, next.snapshot, gates)) return true;
    const prevRules = new Map(pm.prices.map((r) => [ruleKey(r), r]));
    nm.prices = nm.prices.filter((nr) => {
      const pr = prevRules.get(ruleKey(nr));
      const before = pr ? ruleValues(pr) : {};
      const zeroed = Object.entries(ruleValues(nr)).some(([f, b]) => b === 0 && (before[f] ?? 0) > 0);
      if (zeroed) notes.push(`古い・提供終了モデルの単価が0になったため価格ルールを外した: ${nm.id} ${nr.tier}`);
      return !zeroed;
    });
    if (nm.prices.length) return true;
    notes.push(`古い・提供終了モデルの価格がなくなったため掲載から外した: ${nm.id}`);
    return false;
  });
  return notes;
}

const ruleKey = (r: PriceRule) => `${r.tier}|${r.minPromptTokens}|${!!r.promo}|${r.validFrom ?? ""}|${r.validTo ?? ""}`;
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
  if (prev.sources.modelsDev && !next.sources.modelsDev) stop.push("models.dev の出典が欠落");
  const previousMd = prev.sources.modelsDev, nextMd = next.sources.modelsDev;
  if (previousMd && nextMd) {
    if (nextMd.bytes < previousMd.bytes * gates.fetch.minSizeRatio) stop.push("models.dev の取得サイズが急減");
    for (const [provider, before] of Object.entries(previousMd.counts ?? {}))
      if (before && (nextMd.counts?.[provider] ?? 0) < before * gates.fetch.minSizeRatio) stop.push(`models.dev ${provider} の取得件数が急減`);
  }
  if (next.sources.litellm.stale) notes.push("LiteLLM: 前回の正常値を使用");
  if (nextMd?.stale) notes.push("models.dev: 前回の正常値を使用");

  const prevCount = prev.models.length, nextCount = next.models.length;
  if (prevCount && ((prevCount - nextCount) / prevCount) * 100 >= gates.count.maxDropPct)
    stop.push(`件数の急減: ${prevCount} → ${nextCount}`);

  const nextById = new Map(next.models.map((m) => [m.id, m]));
  for (const pm of prev.models) {
    const nm = nextById.get(pm.id);
    if (!nm) continue;
    const retiring = isRetiring(nm, next.snapshot, gates);
    const rules = new Map(nm.prices.map((r) => [ruleKey(r), r]));
    for (const pr of pm.prices) {
      const nr = rules.get(ruleKey(pr));
      for (const [f, a] of Object.entries(ruleValues(pr))) {
        if (!(a && a > 0)) continue;
        const b = nr ? ruleValues(nr)[f] : undefined;
        const label = `${pm.id} ${pr.tier}${pr.minPromptTokens ? `(>${pr.minPromptTokens / 1000}K)` : ""} ${f}`;
        if (!b) {
          if (retiring) notes.push(`古い・提供終了モデルの単価が0・欠落(掲載から外す): ${label} ${a} → ${b ?? "欠落"}`);
          else stop.push(`単価が0になった: ${label} ${a} → ${b ?? "欠落"}`);
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
