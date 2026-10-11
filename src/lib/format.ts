/* 表示用フォーマット */
export type Currency = "JPY" | "USD";
export type Unit = "1K" | "1M";

const nf0 = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
export const int = (x: number): string => nf0.format(x);

/** 有効数字 digits 桁(1000以上は整数) */
export function sig(x: number, digits = 3): string {
  if (x === 0) return "0";
  if (Math.abs(x) >= 1000) return nf0.format(x);
  return Number(x.toPrecision(digits)).toLocaleString("ja-JP", { maximumFractionDigits: 8 });
}

export function money(usd: number, cur: Currency, fx: number): string {
  if (cur === "JPY") {
    const y = usd * fx;
    return (y >= 100 ? nf0.format(Math.round(y)) : y >= 1 ? y.toFixed(1) : sig(y, 2)) + " 円";
  }
  return "$" + (usd >= 100 ? usd.toLocaleString("en-US", { maximumFractionDigits: 0 }) : usd >= 1 ? usd.toFixed(2) : sig(usd, 3));
}

/** USD/1M tokens の単価を表示単位・通貨で */
export function unitPrice(per1M: number | undefined, unit: Unit, cur: Currency, fx: number): string {
  if (per1M == null) return "—";
  const v = unit === "1K" ? per1M / 1000 : per1M;
  return cur === "JPY" ? sig(v * fx, 3) + " 円" : "$" + sig(v, 3);
}

export const unitLabel = (unit: Unit): string => (unit === "1K" ? "/1K tokens" : "/1M tokens");

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
