import { describe, expect, it } from "vitest";
import { crossCheck } from "../../pipeline/crosscheck.ts";
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
