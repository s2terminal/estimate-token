import type { Model, PriceData } from "../shared/types.ts";
import type { GateResult } from "./validate.ts";
import { fmtPct } from "./validate.ts";

export interface DiffSummary {
  added: Model[];
  removed: Model[];
  up: string[];
  down: string[];
}

const base = (m: Model) => m.prices.find((r) => r.tier === "standard" && r.minPromptTokens === 0);

export function diffData(prev: PriceData | null, next: PriceData): DiffSummary {
  const prevById = new Map((prev?.models ?? []).map((m) => [m.id, m]));
  const nextIds = new Set(next.models.map((m) => m.id));
  const out: DiffSummary = { added: [], removed: [], up: [], down: [] };
  if (!prev) return out;
  for (const m of next.models) {
    const p = prevById.get(m.id);
    if (!p) {
      out.added.push(m);
      continue;
    }
    const a = base(p), b = base(m);
    for (const f of ["input", "output", "perImage"] as const) {
      const x = a?.[f], y = b?.[f];
      if (x && y && x !== y) (y > x ? out.up : out.down).push(`${m.id} ${f}: ${x} → ${y}(${fmtPct(((y - x) / x) * 100)})`);
    }
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
  extra: { mismatches: string[]; candidates: string[]; unparsed: string[] },
): string {
  return [
    `## 価格更新 ${next.snapshot}`,
    "",
    `- 判定: ${gate.stop.length ? "**止める**(公開しない)" : "公開"}`,
    `- モデル数: ${next.models.length}`,
    `- 為替: 1 USD = ${next.sources.fx.rate} 円(${next.sources.fx.date}${next.sources.fx.stale ? "、前回値を使用" : ""})`,
    `- LiteLLM: ${next.sources.litellm.commit}`,
    "",
    "### 止めた理由",
    list(gate.stop),
    "",
    "### 記録すること",
    list([...gate.notes, ...extra.mismatches]),
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
    "### 解析できなかったキー(catalog.yaml の見直し候補)",
    list(extra.unparsed, 20),
    "",
  ].join("\n");
}
