import type { Model, PriceRule, PromotionSource, Tier } from "../shared/types.ts";

export const GEMINI_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";
export const PROMOTION_SOURCE = "google-gemini-api";
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
// 同名でも別サービス・別リージョンへ転用しない。対象追加は原文の条件をレビューする。
export const PROMOTION_COVERAGE: Record<string, Tier[]> = {
  "gemini-4-argon": ["standard", "batch", "flex", "priority"],
  "gemini-3.8-flash": ["standard", "batch", "flex", "priority"],
  "gemini-3.6-flash": ["standard", "batch", "flex", "priority"],
  "gemini-robotics-er-2-preview": ["standard", "batch"],
  "gemini-robotics-er-2-streaming-preview": ["standard"],
};

export interface Promotions {
  source: PromotionSource;
  prices: Record<string, PriceRule[]>;
}

function plain(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#36;/g, "$").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
}

/** HTML応答も、見出しと表だけのMarkdownへ変換して同じ厳格な解析を行う。 */
function markdown(body: string): string {
  if (!/<table\b/i.test(body)) return body.replace(/<br\s*\/?\s*>/gi, " ");
  return body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, s: string) => `\n${"#".repeat(Number(n))} ${plain(s)}\n`)
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) =>
      "\n| " + [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => plain(m[1])).join(" | ") + " |\n")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, s: string) => `\`${plain(s)}\``)
    .replace(/<[^>]*>/g, " ");
}

const MONTHS = "January February March April May June July August September October November December".split(" ");
function date(s: string): string {
  const m = /^(\w+) (\d{1,2}), (\d{4})$/.exec(s);
  if (!m || !MONTHS.includes(m[1])) throw new Error(`割引の日付を解析できません: ${s}`);
  const iso = `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (new Date(iso).toISOString().slice(0, 10) !== iso) throw new Error(`不正な日付: ${s}`);
  return iso;
}

function pricePair(cell: string) {
  // モダリティ注記だけを許可。長文・音声別価格や保存料金を推測で混ぜない。
  const match = /^\$([\d.]+)(?:\s*\(text\s*\/\s*image\s*\/\s*video\s*\/\s*audio\))?\s+through (\w+ \d{1,2}, \d{4})\.\s*\$([\d.]+)(?:\s*\(text\s*\/\s*image\s*\/\s*video\s*\/\s*audio\))?\s+starting (\w+ \d{1,2}, \d{4})\.(.*)$/i.exec(plain(cell));
  if (!match) throw new Error(`割引・通常価格の対を解析できません: ${plain(cell)}`);
  const promo = Number(match[1]), regular = Number(match[3]);
  const end = date(match[2]), start = date(match[4]);
  if (!(promo > 0 && regular > promo) || !Number.isFinite(regular) || Date.parse(start) - Date.parse(end) !== 86_400_000)
    throw new Error("割引価格または切替日が不正です");
  return { promo, regular, end, start, tail: match[5].trim() };
}

/** 採用済みURL・CC表示・対象の全料金表が確認できない場合、更新を中断する。 */
export function parsePromotions(body: string, checkedOn: string, url = GEMINI_PRICING_URL): Promotions {
  if (url !== GEMINI_PRICING_URL || !body.includes(LICENSE_URL) ||
      !/Creative Commons Attribution 4\.0/.test(plain(body))) throw new Error("割引データの再利用ライセンスを確認できません");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedOn)) throw new Error("割引データの確認日が不正です");
  const sections = markdown(body).split(/^\s*## (?!#)/m).slice(1);
  const prices: Promotions["prices"] = {};
  for (const [family, tiers] of Object.entries(PROMOTION_COVERAGE)) {
    const matching = sections.filter((s) => s.split(/^\s*### /m)[0].includes(`\`${family}\``));
    if (matching.length !== 1) throw new Error(`割引データのモデル見出しが欠落・重複: ${family}`);
    const blocks = matching[0].split(/^\s*### /m).slice(1);
    prices[family] = [];
    for (const tier of tiers) {
      const bs = blocks.filter((b) => plain(b.split("\n")[0]).toLowerCase() === tier);
      if (bs.length !== 1 || !/Paid Tier,?\s+per 1M tokens in USD/i.test(plain(bs[0])))
        throw new Error(`有料料金表・単位を確認できません: ${family} ${tier}`);
      // セル内の改行を連結。行頭の | は任意、表の各行は | を含む。
      const rows = bs[0].split(/\n(?=[ \t]*(?:\||[^|\n]+\|[^|\n]+\|))/).map((r) => r.trim());
      const promo: PriceRule = { tier, minPromptTokens: 0, promo: true, source: PROMOTION_SOURCE };
      const regular: PriceRule = { tier, minPromptTokens: 0, source: PROMOTION_SOURCE };
      for (const [label, field] of [[/^Input price/, "input"], [/^Output price/, "output"], [/^Context caching price/, "cacheRead"]] as const) {
        const cells = rows.map((r) => r.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map(plain)).filter((r) => label.test(r[0]));
        if (!cells.length && field === "cacheRead" && family.endsWith("streaming-preview")) continue;
        if (cells.length !== 1 || cells[0].length !== 3) throw new Error(`料金行が欠落・重複: ${family} ${tier} ${field}`);
        const p = pricePair(cells[0][2]);
        if (p.tail && !(field === "cacheRead" && /^(Implicit caching only|\$[\d.]+ \/ 1,000,000 tokens per hour \(storage price\))/.test(p.tail)))
          throw new Error(`未対応の価格条件: ${family} ${tier} ${field}`);
        if (promo.validTo && promo.validTo !== p.end) throw new Error("入力・出力・キャッシュの割引期間が一致しません");
        promo.validTo = p.end;
        regular.validFrom = p.start;
        promo[field] = p.promo;
        regular[field] = p.regular;
      }
      prices[family].push(promo, regular);
    }
  }
  return {
    source: { id: PROMOTION_SOURCE, title: "Gemini Developer API pricing", author: "Google", url,
      license: "CC-BY-4.0", licenseUrl: LICENSE_URL, checkedOn,
      modifications: "有料トークン料金と適用日を抜粋・構造化。保存料金・ツール料金・招待制プランを除外。" },
    prices,
  };
}

export function applyPromotions(models: Model[], promotions: Promotions): void {
  for (const m of models) {
    if (m.platform !== "gemini-api" || m.region !== "global" || m.category !== "llm") continue;
    const rules = promotions.prices[m.family];
    if (!rules) continue;
    const tiers = new Set(rules.map((r) => r.tier));
    if (m.prices.some((r) => tiers.has(r.tier) && r.minPromptTokens > 0)) throw new Error(`未対応の長文価格: ${m.id}`);
    m.prices = [...m.prices.filter((r) => !tiers.has(r.tier)), ...structuredClone(rules)];
  }
}
