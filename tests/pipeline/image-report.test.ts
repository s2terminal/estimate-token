import { describe, expect, it } from "vitest";
import { diffData, diffMarkdown } from "../../pipeline/diff.ts";
import { unsupportedImageModels } from "../../pipeline/image-tokens.ts";
import { IMAGE_TOKEN_CONFIG } from "../../shared/image-token-config.ts";
import type { Model } from "../../shared/types.ts";
import { sampleData, sampleModel } from "../support/fixtures.ts";

const unknown = (family = "gpt-image-future"): Model => ({
  ...sampleModel("gpt-image-2@openai:global"),
  id: `${family}@openai:global`, family, name: family,
});

describe("画像換算未対応モデルの更新レポート", () => {
  it("新しい未対応モデルを検出し、次回は新着扱いしない", () => {
    const m = unknown();
    const first = unsupportedImageModels([m]);
    expect(first.all.map((m) => m.id)).toEqual([m.id]);
    expect(first.added).toEqual(first.all);
    const second = unsupportedImageModels([m], [m]);
    expect(second.all).toEqual(first.all);
    expect(second.added).toEqual([]);
  });

  it("既知のモデル・1枚課金・言語モデルは未対応一覧に入らない", () => {
    const data = sampleData();
    const models = data.models.filter((m) => !["gpt-image-1-mini", "chatgpt-image-latest", "gemini-2.0-flash-exp-image-generation", "gemini-2.5-flash-image"].includes(m.family));
    models.push({ ...unknown(), prices: [{ tier: "standard", minPromptTokens: 0, perImage: 0.1, imageOutput: 30 }] });
    expect(unsupportedImageModels(models).all).toEqual([]);
  });

  it("対応設定を追加すると未対応一覧から消える", () => {
    const config = structuredClone(IMAGE_TOKEN_CONFIG);
    config.models["gpt-image-future"] = { profile: "openai-image-2.5" };
    expect(unsupportedImageModels([unknown()], [], config).all).toEqual([]);
  });

  it("1枚課金からトークン課金に変わったモデルも新たな対応対象として検出する", () => {
    const m = unknown();
    const previous = { ...m, prices: [{ tier: "standard" as const, minPromptTokens: 0, perImage: 0.1 }] };
    expect(unsupportedImageModels([m], [previous]).added.map((m) => m.id)).toEqual([m.id]);
  });

  it("レポートに未対応のモデル名・理由と見直す設定ファイルを含める", () => {
    const prev = sampleData(), next = structuredClone(prev);
    next.models.push(unknown());
    const unsupported = unsupportedImageModels(next.models, prev.models);
    const report = diffMarkdown(diffData(prev, next), { stop: [], notes: [] }, next, {
      mismatches: [], candidates: [], unparsed: [],
      unsupportedImages: unsupported.all.map((m) => `${m.id} — ${m.reason}`),
    });
    expect(report).toContain("config/image-tokens.json");
    expect(report).toContain("gpt-image-future@openai:global");
    expect(report).toContain("換算仕様は未対応");
    expect(unsupported.added).toHaveLength(1);
  });
});
