/* 画面の状態。共有リンクにはこの入力値だけが入る(価格は入らない) */
import type { Tier } from "../../shared/types.ts";
import type { ImageUsage, LlmUsage } from "./calc.ts";
import type { Currency, Unit } from "./format.ts";

export type Tab = "llm" | "img";
export type ChartMode = "mix" | "ratio" | "log";

export interface State {
  t: Tab;
  /** 為替の手入力値。null なら取得したレートを使う */
  fx: number | null;
  cur: Currency;
  unit: Unit;
  cm: ChartMode;
  llm: LlmUsage;
  img: ImageUsage;
  sel: { llm: string[]; img: string[] };
}

export const PRESETS: Record<string, { label: string; v: LlmUsage }> = {
  chat: { label: "社内チャットボット", v: { n: 10000, i: 2000, o: 500, c: false, h: 0, tier: "standard" } },
  rag: { label: "RAG検索", v: { n: 10000, i: 10000, o: 1500, c: true, h: 60, tier: "standard" } },
  batch: { label: "大量要約バッチ", v: { n: 100000, i: 4000, o: 300, c: false, h: 0, tier: "batch" } },
};

export const TIERS: Tier[] = ["standard", "batch", "flex", "priority"];

export function defaultState(sel: { llm: string[]; img: string[] } = { llm: [], img: [] }): State {
  return {
    t: "llm",
    fx: null,
    cur: "JPY",
    unit: "1M",
    cm: "mix",
    llm: { ...PRESETS.chat.v },
    img: { n: 1000, i: 100, r: "1K", q: "medium" },
    sel: { llm: [...sel.llm], img: [...sel.img] },
  };
}
