import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../pipeline/config.ts";
import { crossCheck, vendorNotes } from "../../pipeline/crosscheck.ts";
import { TODAY, findModel, openrouterSample, sampleData } from "../support/fixtures.ts";

describe("crossCheck", () => {
  const now = new Date(`${TODAY}T00:00:00Z`);
  const check = (models = sampleData().models) => ({ models, ...crossCheck(models, openrouterSample(), { mismatchPct: 20, recentDays: 60, now }) });

  it("差がしきい値以内なら何も付けない(OpenRouter の id や値は記録しない)", () => {
    const { models, mismatches } = check();
    expect(mismatches).toEqual([]);
    expect(models.some((m) => m.needsReview)).toBe(false);
    expect(JSON.stringify(models)).not.toContain("openrouter");
  });

  it("差が20%超なら needsReview を付け、id だけ返す", () => {
    const models = sampleData().models;
    findModel(models, "gpt-6.1-sol@openai:global").prices[0].input = 1;
    const r = check(models);
    expect(r.mismatches).toEqual(["gpt-6.1-sol@openai:global"]);
    expect(findModel(models, "gpt-6.1-sol@openai:global").needsReview).toBe(true);
  });

  it("OpenRouter にだけある新しいテキストモデルを名前だけ候補にする(公開データには入れない)", () => {
    const { models, candidates } = check();
    const before = sampleData().models.length;
    expect(candidates).toEqual([{ family: "example-new-model", platform: "openai" }]);
    expect(models).toHaveLength(before);
  });
});

describe("vendorNotes", () => {
  const catalog = loadCatalog();

  it("登録済みの開発元だけなら何も出さない", () => {
    expect(vendorNotes(sampleData().models, catalog)).toEqual([]);
  });

  it("大文字小文字だけが違う表記と未登録の開発元を検出する", () => {
    const models = sampleData().models;
    models[0].vendor = "Deepseek";
    models[1].vendor = "DeepSeek";
    models[2].vendor = "Newlab";
    const notes = vendorNotes(models, catalog);
    expect(notes).toContain("開発元の表記ゆれ: Deepseek(1件) / DeepSeek(1件)");
    expect(notes).toContain(`catalog.yaml に未登録の開発元: Deepseek(1件、例: ${models[0].id})`);
    expect(notes).toContain(`catalog.yaml に未登録の開発元: Newlab(1件、例: ${models[2].id})`);
  });
});
