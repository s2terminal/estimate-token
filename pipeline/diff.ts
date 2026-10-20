import type { Model, PriceData } from "../shared/types.ts";
import type { GateResult } from "./validate.ts";
import { fmtPct, ruleValues } from "./validate.ts";
import { pickRule } from "../src/lib/calc.ts";
import type { Skip } from "./models-dev.ts";

export interface DiffSummary {
  added: Model[];
  removed: Model[];
  up: string[];
  down: string[];
  sourceChanges: string[];
  metadataChanges: string[];
}

/** LiteLLM の採用元URLはコミットを含むため、コミットが進んだだけの違いを採用元変更とみなさない */
const sameSource = (a: unknown, b: unknown) => {
  const key = (v: unknown) => JSON.stringify(v)?.replace(/(github\.com\/BerriAI\/litellm\/blob\/)[^/"]+\//g, "$1-/");
  return key(a) === key(b);
};

export function diffData(prev: PriceData | null, next: PriceData): DiffSummary {
  const prevById = new Map((prev?.models ?? []).map((m) => [m.id, m]));
  const nextIds = new Set(next.models.map((m) => m.id));
  const out: DiffSummary = { added: [], removed: [], up: [], down: [], sourceChanges: [], metadataChanges: [] };
  if (!prev) return out;
  for (const m of next.models) {
    const p = prevById.get(m.id);
    if (!p) {
      out.added.push(m);
      continue;
    }
    for (const r of m.prices) {
      const prior = p.prices.find(pr => pr.tier === r.tier && pr.minPromptTokens === r.minPromptTokens &&
        !!pr.promo === !!r.promo && pr.validFrom === r.validFrom && pr.validTo === r.validTo);
      const before = prior ? ruleValues(prior) : {};
      for (const [field, y] of Object.entries(ruleValues(r))) {
        const x = before[field];
        if (x !== undefined && x !== y) (y > x ? out.up : out.down).push(`${m.id} ${r.tier} >${r.minPromptTokens} ${field}: ${x} → ${y}${x ? "(" + fmtPct(((y-x)/x)*100) + ")" : ""}`);
        else if (x === undefined) out.sourceChanges.push(`${m.id} ${r.tier} >${r.minPromptTokens} ${field}: 料金を補完 ${y}`);
      }
      if (prior?.source !== r.source) out.sourceChanges.push(`${m.id} ${r.tier}: 公式料金の採用元 ${prior?.source ?? "なし"} → ${r.source ?? "なし"}`);
      if (!sameSource(prior?.provenance, r.provenance))
        out.sourceChanges.push(`${m.id} ${r.tier} >${r.minPromptTokens}: 採用元 ${JSON.stringify(prior?.provenance ?? {})} → ${JSON.stringify(r.provenance ?? {})}`);
    }
    // 価格ルール自体が同じでも、割引終了で適用単価が変わる日を記録する。
    if (prev.snapshot !== next.snapshot && JSON.stringify(p.prices) === JSON.stringify(m.prices)) {
      for (const tier of new Set(m.prices.map(r => r.tier))) {
        const a = pickRule(p.prices, tier, 0, { asOf: prev.snapshot, promo: true }).rule;
        const b = pickRule(m.prices, tier, 0, { asOf: next.snapshot, promo: true }).rule;
        if (!a || !b) continue;
        for (const [field, y] of Object.entries(ruleValues(b))) {
          const x = ruleValues(a)[field];
          if (x !== undefined && x !== y) (y > x ? out.up : out.down).push(`${m.id} ${tier} 適用価格 ${field}: ${x} → ${y}${x ? "(" + fmtPct(((y-x)/x)*100) + ")" : ""}`);
        }
      }
    }
    for (const field of ["canonicalModelId", "releaseDate", "releaseDateSource", "inputLimit", "totalContext", "outputLimit", "providerStatus"] as const)
      if (!sameSource(p[field], m[field])) out.metadataChanges.push(`${m.id} ${field}: ${JSON.stringify(p[field]) ?? "不明"} → ${JSON.stringify(m[field]) ?? "不明"}`);
  }
  for (const p of prev.models) if (!nextIds.has(p.id)) out.removed.push(p);
  return out;
}

const list = (items: string[], max = 50) =>
  items.length ? items.slice(0, max).map((s) => `- ${s}`).join("\n") + (items.length > max ? `\n- ほか ${items.length - max} 件` : "") : "- なし";

/* OpenRouter の規約に配慮し、レポート(Issue/PRに載る)には OpenRouter の値・id・差異%を書かない */
export function diffMarkdown(
  d: DiffSummary,
  gate: GateResult,
  next: PriceData,
  extra: { mismatches: string[]; candidates: string[]; unparsed: string[]; unsupportedImages: string[]; skipped?: Skip[] },
  options: { detail?: boolean } = {},
): string {
  const skipped = new Map<string, Skip[]>();
  for (const s of extra.skipped ?? []) skipped.set(s.reason, [...(skipped.get(s.reason) ?? []), s]);
  return [
    `## 価格更新 ${next.snapshot}`,
    "",
    `- 判定: ${gate.stop.length ? "**止める**(公開しない)" : "公開"}`,
    `- モデル数: ${next.models.length}`,
    `- 為替: 1 USD = ${next.sources.fx.rate} 円(${next.sources.fx.date}${next.sources.fx.stale ? "、前回値を使用" : ""})`,
    `- LiteLLM: ${next.sources.litellm.commit}`,
    ...(next.sources.modelsDev ? [`- models.dev: ${next.sources.modelsDev.url} SHA-256=${next.sources.modelsDev.sha256}、取得 ${next.sources.modelsDev.fetchedAt}、${next.sources.modelsDev.bytes} bytes${next.sources.modelsDev.stale ? "（前回値）" : ""}`,
      `- models.dev取得件数: ${JSON.stringify(next.sources.modelsDev.counts ?? {})}`] : []),
    "",
    "### 止めた理由",
    list(gate.stop),
    "",
    "### 記録すること",
    list([...gate.notes, ...extra.mismatches], Infinity),
    "",
    "### 新モデル",
    list(d.added.map((m) => m.id)),
    "",
    "### LiteLLM 未収録の新モデル候補(LiteLLM に載るまで公開されません)",
    list(extra.candidates),
    "",
    "### 廃止・消えたモデル",
    list(d.removed.map((m) => m.id)),
    "",
    "### 値上げ",
    list(d.up),
    "",
    "### 値下げ",
    list(d.down),
    "",
    "### 料金の補完・採用元変更",
    list(d.sourceChanges ?? [], Infinity),
    "",
    "### モデル情報の変更",
    list(d.metadataChanges ?? [], Infinity),
    "",
    "### 解析できなかったキー(catalog.yaml の見直し候補)",
    list(extra.unparsed, 20),
    "",
    "### 画像トークン換算が未対応のモデル(config/image-tokens.json の見直し候補)",
    list(extra.unsupportedImages),
    "",
    "### models.dev で採用を見送った件数(毎回ほぼ同じ。明細は report-full.md)",
    list([...skipped].map(([reason, items]) => `${reason}: ${items.length} 件`), Infinity),
    "",
    ...(options.detail ? [...skipped].flatMap(([reason, items]) => [`#### ${reason}`, list(items.map((s) => s.item), Infinity), ""]) : []),
  ].join("\n");
}

/** GitHub の Issue コメント・PR 本文の上限(65536文字)。余裕を見て少し下回る長さで切る */
export const GITHUB_BODY_LIMIT = 60000;

/** 長すぎるレポートを行単位で切り詰め、全文の置き場所を末尾に添える */
export function fitMarkdown(md: string, fullUrl?: string, max = GITHUB_BODY_LIMIT): string {
  if ([...md].length <= max) return md;
  const note = `\n\n---\n文字数の上限を超えたため途中で省略しました。全文は ${fullUrl ? `[実行の artifact](${fullUrl}) の` : "artifact の "}out/report-full.md を見てください。\n`;
  const budget = max - [...note].length;
  const kept: string[] = [];
  let size = 0;
  for (const line of md.split("\n")) {
    const len = [...line].length + 1;
    if (size + len > budget) break;
    kept.push(line);
    size += len;
  }
  return kept.join("\n") + note;
}
