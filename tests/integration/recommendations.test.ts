import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../pipeline/config.ts";
import { applyRecommendations } from "../../pipeline/recommend.ts";
import type { PriceData } from "../../shared/types.ts";
import { visibleModels } from "../../src/lib/models.ts";
import { decodeState, encodeState } from "../../src/lib/permalink.ts";
import { defaultState } from "../../src/lib/state.ts";

const catalog = loadCatalog();

describe("公開データと画面の初期選択", () => {
  const data: PriceData = JSON.parse(readFileSync(new URL("../../public/data/latest.json", import.meta.url), "utf8"));
  it("公開済みのfeaturedが選定規則に一致し、提供先・地域で重複しない", () => {
    const models = structuredClone(data.models);
    applyRecommendations(models, catalog.recommendations);
    const ids = models.filter(m => m.featured).map(m => m.id);
    expect(ids).toEqual(data.models.filter(m => m.featured).map(m => m.id));
    const selected = models.filter(m => m.featured);
    expect(selected.filter(m => m.category === "llm")).toHaveLength(9);
    expect(selected.filter(m => m.category === "image")).toHaveLength(6);
    expect(new Set(selected.map(m => `${m.vendor}|${m.family}`)).size).toBe(selected.length);
    expect(selected.every(m => ["openai", "anthropic", "gemini-api"].includes(m.platform))).toBe(true);
  });
  it("おすすめから外したVertex AIも検索・手動選択・共有リンクでは使える", () => {
    const id = "gemini-3.8-flash@vertex-ai:global";
    const filters = { q: "", vendor: "", platform: "", region: "" };
    expect(visibleModels(data.models, data, { ...filters, platform: "vertex-ai", q: "gemini-3.8-flash" }, new Set()).some(m => m.id === id)).toBe(true);
    expect(visibleModels(data.models, data, filters, new Set([id])).some(m => m.id === id)).toBe(true);
    const state = defaultState({ llm: [id], img: [] });
    expect(decodeState(encodeState(state))?.state.sel.llm).toEqual([id]);
  });
});
