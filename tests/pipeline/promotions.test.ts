import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PriceData } from "../../shared/types.ts";
import { applyPromotions, GEMINI_PRICING_URL, parsePromotions } from "../../pipeline/promotions.ts";
import { fetchPromotions } from "../../pipeline/fetch.ts";
import { evaluateGates, validateSchema } from "../../pipeline/validate.ts";
import { loadGates } from "../../pipeline/config.ts";
import { pickRule, calcLlm } from "../../src/lib/calc.ts";
import { diffData } from "../../pipeline/diff.ts";
import { contentHash } from "../../pipeline/content.ts";
import { sourceCell } from "../../src/lib/sources.ts";

const reviewed = readFileSync(new URL("../../config/pricing/gemini-api-reviewed.md", import.meta.url), "utf8");
const parsed = () => parsePromotions(reviewed, "2026-10-18");
const published = (): PriceData => JSON.parse(readFileSync(new URL("../../public/data/latest.json", import.meta.url), "utf8"));

describe("公式料金表の割引取り込み", () => {
  it("5モデルの入力・出力・キャッシュと15組の切替日を読む", () => {
    const p = parsed();
    expect(Object.keys(p.prices)).toHaveLength(5);
    expect(Object.values(p.prices).flat().filter((r) => r.promo)).toHaveLength(15);
    expect(p.prices["gemini-4-argon"][0]).toMatchObject({ input: 2, output: 10, cacheRead: .1, validTo: "2026-11-30" });
    expect(p.prices["gemini-3.8-flash"][1]).toMatchObject({ input: 1.5, output: 7.5, cacheRead: .15, validFrom: "2027-01-01" });
  });

  it("セル内の改行・モダリティ注記・保存料金を区別する", () => {
    const body = reviewed.replace(/\. \$/g, ".\n$")
      .replace("$1 through December", "$1 (text / image / video / audio) through December")
      .replace("$0.15 starting January 1, 2027.", "$0.15 starting January 1, 2027.<br>$0.50 / 1,000,000 tokens per hour (storage price) through December 31, 2026. $1.00 / 1,000,000 tokens per hour (storage price) starting January 1, 2027.");
    expect(parsePromotions(body, "2026-10-18").prices).toEqual(parsed().prices);
  });

  it("HTMLの見出し・表も読める", () => {
    const html = reviewed.split("\n").map((line) => {
      if (line.startsWith("### ")) return `<h3 id="tier">${line.slice(4)}</h3>`;
      if (line.startsWith("## ")) return `<h2>${line.slice(3)}</h2>`;
      if (line.startsWith("| ---")) return "";
      if (line.startsWith("|")) return `<table><tr>${line.slice(1, -1).split("|").map((c) => `<td>${c}</td>`).join("")}</tr></table>`;
      return line.replace(/`([^`]+)`/g, "<code>$1</code>");
    }).join("\n");
    expect(parsePromotions(html, "2026-10-18").prices).toEqual(parsed().prices);
  });

  it.each([
    ["ライセンス欠落", (s: string) => s.replace("Creative Commons Attribution 4.0", "All rights reserved")],
    ["ライセンスリンク欠落", (s: string) => s.replace("https://creativecommons.org/licenses/by/4.0/", "https://example.com")],
    ["単位変更", (s: string) => s.replace("per 1M", "per 1K")],
    ["価格の逆転", (s: string) => s.replace("$4 starting", "$1 starting")],
    ["不正な日付", (s: string) => s.replace("November 30", "November 31")],
    ["切替日の隙間", (s: string) => s.replace("December 1,", "December 2,")],
    ["入力出力の期間不一致", (s: string) => s.replace("$10 through November 30, 2026. $20 starting December 1, 2026.", "$10 through December 31, 2026. $20 starting January 1, 2027.")],
    ["見出し変更", (s: string) => s.replace("### Batch", "### Different")],
    ["条件追加", (s: string) => s.replace("$4 starting December 1, 2026.", "$4 starting December 1, 2026. Prompts <= 200K only.")],
  ])("%sなら公開用のデータを返さない", (_, change) => {
    expect(() => parsePromotions(change(reviewed), "2026-10-18")).toThrow();
  });

  it("Cloudなど未採用のURLは同じ内容でも拒否する", () => {
    expect(() => parsePromotions(reviewed, "2026-10-18", "https://cloud.google.com/vertex-ai/generative-ai/pricing")).toThrow(/ライセンス/);
  });

  it("提供先を限定して置換し、再適用しても重複しない", () => {
    const data = published(), before = structuredClone(data);
    applyPromotions(data.models, parsed());
    const once = structuredClone(data);
    applyPromotions(data.models, parsed());
    expect(data).toEqual(once);
    for (const m of data.models.filter((m) => m.platform !== "gemini-api" || !parsed().prices[m.family])) {
      expect(m).toEqual(before.models.find((b) => b.id === m.id));
    }
  });
});

describe("取得時の中断条件", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("Markdownを希望し、確認できたライセンスを返す", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("User-agent: *\nDisallow:\nSitemap: https://ai.google.dev/sitemap.xml"))
      .mockResolvedValueOnce(new Response(reviewed));
    vi.stubGlobal("fetch", fetch);
    const p = await fetchPromotions();
    expect(p.promotions.source.url).toBe(GEMINI_PRICING_URL);
    expect(fetch.mock.calls[1][1].headers.accept).toContain("text/markdown");
  });
  it("robotsで制限が追加されたら料金表を取得しない", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("User-agent: *\nDisallow: /"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchPromotions()).rejects.toThrow(/robots/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([new Response("Unavailable", { status: 503 }), new Response("No license")])("取得・ライセンス確認失敗を握りつぶさない", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("User-agent: *\nDisallow:\n"))
      .mockResolvedValueOnce(response));
    await expect(fetchPromotions()).rejects.toThrow();
  });
});

describe("公開データからの試算・品質ゲート", () => {
  it("公式料金の出典とmodels.devのリリース日出典を両方表示する", () => {
    const data = published();
    const m = data.models.find(m => m.id === "gemini-3.8-flash@gemini-api:global")!;
    const html = sourceCell(m, m.prices.find(r => r.promo), data.sources.promotions);
    expect(html).toContain("Google公式");
    expect(html).toContain("CC BY 4.0");
    expect(html).toContain("リリース");
    expect(html).toContain("models.dev");
    expect(html).not.toContain("LiteLLM");
  });
  it("公式料金の確認日が進むと期間判定用のスナップショットを更新する", () => {
    const before = published(), after = structuredClone(before);
    after.sources.promotions![0].checkedOn = "2026-10-19";
    expect(contentHash(before)).not.toBe(contentHash(after));
  });
  it("Gemini 3.8 Flash: 通常価格は月$67.50、割引を含むと$33.75", () => {
    const data = published();
    // 日次の実価格変更で固定期待値が壊れないよう、レビュー済み料金で検算する。
    applyPromotions(data.models, parsed());
    const m = data.models.find((m) => m.id === "gemini-3.8-flash@gemini-api:global")!;
    const u = { n: 10000, i: 2000, o: 500, c: false, h: 0, tier: "standard" as const };
    expect(calcLlm(m, u, { asOf: "2026-10-18", promo: false })).toMatchObject({ usd: 67.5, na: false });
    expect(calcLlm(m, u, { asOf: "2026-10-18", promo: true })).toMatchObject({ usd: 33.75, na: false });
  });
  it("全プランで終了日を含み、翌日は通常価格へ切り替わる", () => {
    for (const rules of Object.values(parsed().prices)) {
      for (const promo of rules.filter((r) => r.promo)) {
        const regular = rules.find((r) => r.tier === promo.tier && !r.promo)!;
        expect(pickRule(rules, promo.tier, 1000, { asOf: promo.validTo!, promo: true }).rule).toEqual(promo);
        expect(pickRule(rules, promo.tier, 1000, { asOf: promo.validTo!, promo: false }).rule).toEqual(regular);
        expect(pickRule(rules, promo.tier, 1000, { asOf: regular.validFrom!, promo: true }).rule).toEqual(regular);
      }
    }
  });
  it("同じ割引データの更新で通常価格と割引価格を誤比較しない", () => {
    const d = published();
    expect(validateSchema(d)).toEqual([]);
    expect(evaluateGates(d, structuredClone(d), loadGates())).toEqual({ stop: [], notes: [] });
  });
  it("割引情報が消えた更新をゲートで止める", () => {
    const prev = published(), next = structuredClone(prev);
    for (const m of next.models) m.prices = m.prices.filter((r) => !r.promo);
    expect(evaluateGates(prev, next, loadGates()).stop.length).toBeGreaterThan(0);
  });
  it("期間終了を価格差分にも反映する", () => {
    const prev = published();
    applyPromotions(prev.models, parsed());
    const next = structuredClone(prev);
    prev.snapshot = "2026-11-30";
    next.snapshot = "2026-12-01";
    expect(diffData(prev, next).up).toContain("gemini-4-argon@gemini-api:global standard 適用価格 input: 2 → 4(+100%)");
  });
});
