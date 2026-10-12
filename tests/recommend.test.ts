import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadCatalog, type RecommendationGroup } from "../pipeline/config.ts";
import { normalize } from "../pipeline/normalize.ts";
import { applyRecommendations, releaseDate } from "../pipeline/recommend.ts";
import type { Model, Platform, PriceData } from "../shared/types.ts";
import { visibleModels } from "../src/lib/models.ts";
import { decodeState, encodeState } from "../src/lib/permalink.ts";
import { defaultState } from "../src/lib/state.ts";

const catalog = loadCatalog();
const group: RecommendationGroup[] = [{ vendor: "Google", category: "llm", pattern: "^gemini-[0-9.]+-flash$" }];
const model = (family: string, platform: Platform = "gemini-api", extra: Partial<Model> = {}): Model => ({
  id: `${family}@${platform}:global`, family, name: family, vendor: "Google", platform, region: "global", category: "llm",
  firstSeen: "2026-10-12", status: "active", prices: [{ tier: "standard", minPromptTokens: 0, input: 1, output: 5 }], sources: [], ...extra,
});
const picks = (models: Model[], groups = group) => {
  applyRecommendations(models, groups);
  return models.filter(m => m.featured).map(m => m.id);
};

describe("おすすめモデル", () => {
  it("同じ用途では旧世代を外し、数値バージョンで最新を選ぶ", () => {
    expect(picks([model("gemini-3.9-flash"), model("gemini-3.10-flash"), model("gemini-3.8-flash", "gemini-api", { featured: true })]))
      .toEqual(["gemini-3.10-flash@gemini-api:global"]);
  });

  it("明示されたリリース日時があればバージョン順より優先する", () => {
    expect(picks([
      model("gemini-3.9-flash", "gemini-api", { releaseDate: "2026-10-12T09:00:00+09:00" }),
      model("gemini-3.8-flash", "gemini-api", { releaseDate: "2026-10-12T01:00:00Z" }),
    ])).toEqual(["gemini-3.8-flash@gemini-api:global"]);
  });

  it("日時不明の後継モデルとは数値バージョンで比較する", () => {
    expect(picks([
      model("gemini-4-flash"),
      model("gemini-3.8-flash", "gemini-api", { releaseDate: "2026-10-12" }),
      model("gemini-3.9-flash", "gemini-api", { releaseDate: "2026-10-12" }),
    ])).toEqual(["gemini-4-flash@gemini-api:global"]);
  });

  it("既知日時の最新と未知日時の最新を比較し、入力順に依存しない", () => {
    const models = [
      model("gemini-3.9-flash", "gemini-api", { releaseDate: "2026-09-01" }),
      model("gemini-3.8-flash", "gemini-api", { releaseDate: "2026-10-12" }),
      model("gemini-3.7-flash"),
    ];
    expect(picks(models)).toEqual(["gemini-3.8-flash@gemini-api:global"]);
    expect(picks([...models].reverse())).toEqual(["gemini-3.8-flash@gemini-api:global"]);
    models[0].releaseDate = "2026-10-12";
    expect(picks(models)).toEqual(["gemini-3.9-flash@gemini-api:global"]);
  });

  it("firstSeenが新しくても旧モデルを優先しない", () => {
    expect(picks([
      model("gemini-3.7-flash", "gemini-api", { firstSeen: "2026-10-12" }),
      model("gemini-3.8-flash", "gemini-api", { firstSeen: "2026-09-01" }),
    ])).toEqual(["gemini-3.8-flash@gemini-api:global"]);
  });

  it("価格や提供先の追加日が違ってもGemini APIとVertex AIを重複選択しない", () => {
    const models = [
      model("gemini-3.8-flash", "vertex-ai", { releaseDate: "2026-10-12", prices: [{ tier: "standard", minPromptTokens: 0, input: 0.5, output: 2 }] }),
      model("gemini-3.8-flash", "gemini-api", { releaseDate: "2026-10-01" }),
    ];
    const before = structuredClone(models);
    expect(picks(models)).toEqual(["gemini-3.8-flash@gemini-api:global"]);
    expect(picks([...models].reverse())).toEqual(["gemini-3.8-flash@gemini-api:global"]);
    expect(models.map(({ featured, ...m }) => m)).toEqual(before);
  });

  it("直販がなくても最新モデルの提供先を1件選ぶ", () => {
    expect(picks([model("gemini-3.7-flash"), model("gemini-3.8-flash", "vertex-ai")]))
      .toEqual(["gemini-3.8-flash@vertex-ai:global"]);
  });

  it("廃止済み・価格不足・用途の異なる特化版を除く", () => {
    expect(picks([
      model("gemini-3.8-flash"), model("gemini-4-flash", "gemini-api", { status: "deprecated" }),
      model("gemini-5-flash", "gemini-api", { prices: [{ tier: "standard", minPromptTokens: 0, input: 1 }] }),
      model("gemini-6-flash-cyber"), model("gemini-flash-latest"), model("gemini-7-flash-preview"),
    ])).toEqual(["gemini-3.8-flash@gemini-api:global"]);
  });

  it("画像の換算未対応モデルは後継でもおすすめにしない", () => {
    const image = (family: string) => model(family, "openai", {
      category: "image", vendor: "OpenAI", prices: [{ tier: "standard", minPromptTokens: 0, input: 5, imageOutput: 30 }],
    });
    expect(picks([image("gpt-image-2"), image("gpt-image-2.5-sunburst"), image("gpt-image-9-sunburst")], catalog.recommendations))
      .toEqual(["gpt-image-2.5-sunburst@openai:global"]);
  });
});

describe("リリース日時の取り込み", () => {
  it.each(["2026-10-12", "2026-10-12T00:01:02Z", "2026-10-12T09:01:02.123+09:00"])("明示日時 %s を保持する", value => {
    expect(releaseDate(value)).toBe(value);
  });
  it.each([undefined, null, 123, "", "unknown", "2026-02-30", "2026-13-01", "2026-10-12T00:00:00", "2026-10-12T99:00:00Z"])("不正な日時 %s は使用しない", value => {
    expect(releaseDate(value)).toBeUndefined();
  });
  it("normalizeがrelease_dateを保持し、日付付きモデルIDを発売日とみなさない", () => {
    const e = { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 0.000001, output_cost_per_token: 0.000005 };
    const { models } = normalize([
      ["gemini/gemini-3.8-flash", { ...e, release_date: "2026-10-12" }],
      ["gemini/gemini-3.9-flash", { ...e, release_date: "2026-09-01" }],
      ["gemini/gemini-3.7-flash-2026-10-11", e],
    ], catalog);
    expect(models.find(m => m.featured)?.family).toBe("gemini-3.8-flash");
    expect(models.find(m => m.family === "gemini-3.8-flash")?.releaseDate).toBe("2026-10-12");
    expect(models.find(m => m.family === "gemini-3.7-flash")?.releaseDate).toBeUndefined();
  });
});

describe("公開データと画面の初期選択", () => {
  const data: PriceData = JSON.parse(readFileSync(new URL("../public/data/latest.json", import.meta.url), "utf8"));
  it("公開済みのfeaturedが選定規則に一致し、提供先・地域で重複しない", () => {
    const models = structuredClone(data.models);
    const ids = picks(models, catalog.recommendations);
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
