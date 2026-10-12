/* 共有リンク: 入力値と選んだモデルの id を JSON にして base64url で # 以降に入れる。
   先頭の版番号で形式を見分ける(e2: 現行、e1: プロトタイプ) */
import type { Tier } from "../../shared/types.ts";
import { IMAGE_QUALITIES, IMAGE_SIZES } from "./image-tokens.ts";
import { type State, TIERS, defaultState } from "./state.ts";

export const VERSION = "e2";

export function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** 状態を # 以降の文字列にする。選択は表示中のタブの分だけ入れる */
export function encodeState(s: State): string {
  const o = { t: s.t, fx: s.fx, cur: s.cur, unit: s.unit, cm: s.cm, llm: s.llm, img: { n: s.img.n, i: s.img.i, r: s.img.r, q: s.img.q }, sel: { [s.t]: s.sel[s.t] } };
  return VERSION + b64urlEncode(JSON.stringify(o));
}

export interface Decoded {
  state: State;
  /** 選択が入っていたタブ(既定の選択を上書きする) */
  selTabs: (keyof State["sel"])[];
  warning?: string;
}

const num = (v: unknown, d: number, min = 0, max = Infinity) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const ids = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

type Raw = Record<string, any>;

function merge(o: Raw, base: State): Decoded {
  const L = o.llm ?? {}, I = o.img ?? {};
  const state: State = {
    t: oneOf(o.t, ["llm", "img"] as const, base.t),
    fx: typeof o.fx === "number" && o.fx > 0 ? o.fx : null,
    cur: oneOf(o.cur, ["JPY", "USD"] as const, base.cur),
    unit: oneOf(o.unit, ["1K", "1M"] as const, base.unit),
    cm: oneOf(o.cm, ["mix", "ratio", "log"] as const, base.cm),
    llm: {
      n: num(L.n, base.llm.n),
      i: num(L.i, base.llm.i),
      o: num(L.o, base.llm.o),
      c: typeof L.c === "boolean" ? L.c : base.llm.c,
      h: num(L.h, base.llm.h, 0, 100),
      tier: oneOf<Tier>(L.tier, TIERS, base.llm.tier),
    },
    img: {
      n: num(I.n, base.img.n), i: num(I.i, base.img.i ?? 0), r: oneOf(I.r, ["1K", "2K", "4K"] as const, "1K"),
      q: oneOf(I.q, IMAGE_QUALITIES, base.img.q ?? "medium"),
    },
    sel: { llm: [...base.sel.llm], img: [...base.sel.img] },
  };
  const selTabs: Decoded["selTabs"] = [];
  for (const t of ["llm", "img"] as const) {
    const v = ids(o.sel?.[t]);
    if (v) {
      state.sel[t] = v;
      selTabs.push(t);
    }
  }
  const size = IMAGE_SIZES[state.img.r];
  const changedSize = (I.w != null && I.w !== size.width) || (I.h != null && I.h !== size.height);
  return { state, selTabs, ...(changedSize ? { warning: `幅・高さを指定した旧リンクです。解像度${state.img.r}の固定サイズ(${size.width}×${size.height})で試算します` } : {}) };
}

/**
 * # 以降の文字列から状態を読む。読めなければ null。
 * base は既定の状態(価格データから決まる既定の選択を含む)。
 */
export function decodeState(hash: string, base: State = defaultState()): Decoded | null {
  const h = hash.replace(/^#/, "");
  try {
    if (h.startsWith("e2")) return merge(JSON.parse(b64urlDecode(h.slice(2))), base);
    if (h.startsWith("e1")) {
      // プロトタイプの形式。為替は当時の既定値(158)も入っているので手入力扱いにはしない。モデルの id は互換がない
      const o = JSON.parse(b64urlDecode(h.slice(2))) as Raw;
      const { sel: _sel, fx: _fx, ...rest } = o;
      const t = o.t === "img" ? "img" : "llm";
      const d = merge({ ...rest, t }, base);
      return { ...d, warning: "古い形式のリンクです。入力値は復元しましたが、モデルの選択は初期値にしました" };
    }
  } catch {
    return null;
  }
  return null;
}
