/* 価格差グラフ(横棒・インラインSVG)
   月額(内訳): 線形の積み上げ。倍率: 最安を1とした合計。対数: 合計を10倍刻みの目盛で。 */
import type { Part, PartKey } from "../lib/calc.ts";
import { type Currency, esc, money, sig } from "../lib/format.ts";
import type { ChartMode } from "../lib/state.ts";

export interface ChartRow {
  name: string;
  sub: string;
  plat: string;
  total: number;
  parts: Part[];
}

export interface ChartCtx {
  cm: ChartMode;
  /** 入力・キャッシュ・出力の内訳を色分けするか */
  multi: boolean;
  cur: Currency;
  fx: number;
}

export const SERIES: Record<PartKey, { label: string; c: string }> = {
  in: { label: "入力", c: "s1" },
  cache: { label: "キャッシュ読取", c: "s3" },
  out: { label: "出力", c: "s2" },
  total: { label: "月額", c: "s1" },
};

function niceTicks(max: number, n = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / n, p = Math.pow(10, Math.floor(Math.log10(raw))), e = raw / p;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * p;
  const top = Math.ceil(max / step - 1e-9) * step;
  const t: number[] = [];
  for (let v = 0; v <= top + step * 1e-6; v += step) t.push(+v.toPrecision(12));
  return t;
}

/** 右端(データの先端)だけ角丸 */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (w <= 0) return "";
  r = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

export function chartSVG(rows: ChartRow[], W: number, ctx: ChartCtx): string {
  const disp = (usd: number) => (ctx.cur === "JPY" ? usd * ctx.fx : usd);
  const fmt = (usd: number) => money(usd, ctx.cur, ctx.fx);
  const compact = (v: number) => {
    const pre = ctx.cur === "USD" ? "$" : "", suf = ctx.cur === "JPY" ? "円" : "";
    const a = Math.abs(v);
    const s = ctx.cur === "JPY" && a >= 10000 ? sig(v / 10000, 3) + "万" : ctx.cur === "USD" && a >= 1000 ? sig(v / 1000, 3) + "K" : sig(v, 3);
    return pre + s + suf;
  };
  const fill = (k: string) => `style="fill:var(--${k})"`;
  const narrow = W < 560;
  const padL = 0, padR = narrow ? 78 : 96, top = 24, rowH = 44, barH = 12;
  const plotW = Math.max(60, W - padL - padR), n = rows.length;
  const H = top + rowH * n + 6;
  const totals = rows.map((r) => disp(r.total));
  const vals: number[] = [];
  let X: (v: number) => number, ticks: number[], tickLab: (t: number) => string, valLab: (i: number) => string;

  if (ctx.cm === "ratio") {
    const base = Math.min(...rows.map((r) => r.total).filter((v) => v > 0));
    rows.forEach((r) => vals.push(base > 0 && Number.isFinite(base) ? r.total / base : 0));
    ticks = niceTicks(Math.max(...vals, 1));
    const mx = ticks[ticks.length - 1];
    X = (v) => padL + (v / mx) * plotW;
    tickLab = (t) => "×" + sig(t, 3);
    valLab = (i) => "×" + (vals[i] >= 10 ? sig(vals[i], 3) : vals[i].toFixed(vals[i] < 1.995 ? 2 : 1));
  } else if (ctx.cm === "log") {
    const pos = totals.filter((v) => v > 0);
    const lo = pos.length ? Math.pow(10, Math.floor(Math.log10(Math.min(...pos)))) : 1;
    let hi = pos.length ? Math.pow(10, Math.ceil(Math.log10(Math.max(...pos)))) : 10;
    if (hi <= lo) hi = lo * 10;
    const L = Math.log10(lo), R = Math.log10(hi);
    X = (v) => (v > 0 ? padL + ((Math.log10(v) - L) / (R - L)) * plotW : padL);
    ticks = [];
    for (let e = L; e <= R + 1e-9; e++) ticks.push(Math.pow(10, e));
    tickLab = compact;
    vals.push(...totals);
    valLab = (i) => fmt(rows[i].total);
  } else {
    ticks = niceTicks(Math.max(...totals));
    const mx = ticks[ticks.length - 1];
    X = (v) => padL + (v / mx) * plotW;
    tickLab = compact;
    vals.push(...totals);
    valLab = (i) => fmt(rows[i].total);
  }

  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  for (const t of ticks) {
    const x = X(t);
    s += `<line x1="${x}" x2="${x}" y1="${top - 6}" y2="${top + rowH * n}" class="c-grid"/>`;
    s += `<text x="${x}" y="${top - 12}" text-anchor="${x > padL + plotW - 20 ? "end" : x < padL + 20 ? "start" : "middle"}" class="c-tick">${esc(tickLab(t))}</text>`;
  }
  rows.forEach((r, i) => {
    const y0 = top + i * rowH, by = y0 + 20;
    s += `<g class="c-row" data-i="${i}" tabindex="0" aria-label="${esc(r.name)} ${esc(fmt(r.total))}/月">`;
    s += `<rect class="c-hit" x="${padL - 6}" y="${y0 + 1}" width="${W - padL + 6}" height="${rowH - 2}" rx="4"/>`;
    s += `<text x="${padL}" y="${y0 + 14}" class="c-name">${esc(r.name)}<tspan dx="8" class="c-sub">${esc(narrow ? r.plat : r.sub)}</tspan></text>`;
    let x = padL;
    if (ctx.cm === "mix") {
      const segs = ctx.multi ? r.parts.filter((p) => p.v > 0) : [{ k: "total" as const, v: r.total }];
      segs.forEach((p, j) => {
        const w = X(disp(p.v)) - padL;
        const last = j === segs.length - 1;
        const gw = last ? w : Math.max(0, w - 2);
        if (gw > 0)
          s += last
            ? `<path d="${barPath(x, by, gw, barH, 3)}" ${fill(SERIES[p.k].c)}/>`
            : `<rect x="${x}" y="${by}" width="${gw}" height="${barH}" ${fill(SERIES[p.k].c)}/>`;
        x += w;
      });
    } else {
      const w = Math.max(vals[i] > 0 ? 2 : 0, X(vals[i]) - padL);
      s += `<path d="${barPath(padL, by, w, barH, 3)}" ${fill("s1")}/>`;
      x = padL + w;
    }
    s += `<text x="${x + 6}" y="${by + barH - 1}" class="c-val">${esc(valLab(i))}</text>`;
    s += `</g>`;
  });
  return s + `</svg>`;
}

export function chartNoteText(cm: ChartMode, multi: boolean): string {
  if (cm === "ratio") return "最も安いモデルを ×1 とした月額の倍率です。";
  if (cm === "log") return "横軸は対数目盛(1目盛ごとに10倍)です。桁の違うモデルも一緒に比べられます。";
  return multi ? "棒の長さが月額です。色は入力・キャッシュ読取・出力の内訳を表します。" : "棒の長さが月額です。";
}

export function tooltipHTML(r: ChartRow, rows: ChartRow[], ctx: ChartCtx): string {
  const fmt = (usd: number) => money(usd, ctx.cur, ctx.fx);
  const base = Math.min(...rows.map((x) => x.total).filter((v) => v > 0));
  let h = `<div class="t">${esc(r.name)}</div><div class="mmeta">${esc(r.sub)}</div>`;
  if (ctx.multi)
    r.parts.forEach((p) => {
      const pct = r.total > 0 ? Math.round((p.v / r.total) * 100) : 0;
      h += `<div class="r"><span><i style="background:var(--${SERIES[p.k].c})"></i>${SERIES[p.k].label}</span><span>${fmt(p.v)}(${pct}%)</span></div>`;
    });
  h += `<div class="r"><span>月額</span><span><b>${fmt(r.total)}</b></span></div><div class="r"><span>年額</span><span>${fmt(r.total * 12)}</span></div>`;
  if (base > 0 && Number.isFinite(base)) h += `<div class="r"><span>最安との倍率</span><span>×${sig(r.total / base, 3)}</span></div>`;
  return h;
}
