import { describe, expect, it } from "vitest";
import type { PriceData } from "../../shared/types.ts";
import { loadGates } from "../../pipeline/config.ts";
import { checkFx, dropZeroedRetiring, evaluateGates, isRetiring, validateSchema } from "../../pipeline/validate.ts";
import { findModel, sampleData } from "../support/fixtures.ts";

const gates = loadGates();
const target = (d: PriceData) => findModel(d.models, "gpt-6.1-sol@openai:global");

describe("validateSchema", () => {
  it("正常なデータはエラーなし", () => {
    expect(validateSchema(sampleData())).toEqual([]);
  });
  it("負の単価・NaN はエラー", () => {
    const d = sampleData();
    target(d).prices[0].input = -1;
    target(d).prices[1].output = Number.NaN;
    expect(validateSchema(d).length).toBe(2);
  });
  it("画像出力トークン単価のNaNを検知する", () => {
    const d = sampleData();
    findModel(d.models, "gpt-image-2@openai:global").prices[0].imageOutput = NaN;
    expect(validateSchema(d)).toHaveLength(1);
  });
});

describe("evaluateGates", () => {
  it("前回と同じなら止めない", () => {
    const d = sampleData();
    expect(evaluateGates(d, structuredClone(d), gates)).toEqual({ stop: [], notes: [] });
  });

  it("件数が半減したら止める", () => {
    const prev = sampleData();
    const next = structuredClone(prev);
    next.models = next.models.slice(0, Math.floor(next.models.length / 2));
    expect(evaluateGates(prev, next, gates).stop.some((s) => s.startsWith("件数の急減"))).toBe(true);
  });

  it.each([
    { label: "入力が0", id: "gpt-6.1-sol@openai:global", field: "input", value: 0, reason: "単価が0になった" },
    { label: "出力が欠落", id: "gpt-6.1-sol@openai:global", field: "output", value: undefined, reason: "単価が0になった" },
    { label: "入力が60%増", id: "gpt-6.1-sol@openai:global", field: "input", value: 3.2, reason: "大きな値変わり" },
    { label: "画像出力が100%増", id: "gpt-image-2@openai:global", field: "imageOutput", value: 60, reason: "大きな値変わり" },
    { label: "画像出力が欠落", id: "gpt-image-2@openai:global", field: "imageOutput", value: undefined, reason: "単価が0になった" },
  ] as const)("$labelなら公開を止める", ({ id, field, value, reason }) => {
    const prev = sampleData(), next = structuredClone(prev);
    const rule = findModel(next.models, id).prices[0];
    if (value === undefined) { delete rule[field]; delete rule.provenance?.[field]; }
    else rule[field] = value;
    expect(evaluateGates(prev, next, gates).stop).toEqual([
      expect.stringContaining(`${reason}: ${id} standard ${field}`),
    ]);
  });

  it("±10〜50%は公開して記録する", () => {
    const prev = sampleData();
    const next = structuredClone(prev);
    target(next).prices[0].input = 2.4; // +20%
    const r = evaluateGates(prev, next, gates);
    expect(r.stop).toEqual([]);
    expect(r.notes).toHaveLength(1);
  });

  it("取得サイズが前回の50%未満なら止める", () => {
    const prev = sampleData();
    const next = structuredClone(prev);
    next.sources.litellm.bytes = 40_000;
    expect(evaluateGates(prev, next, gates).stop.some((s) => s.startsWith("取得失敗"))).toBe(true);
  });
});

describe("古い・提供終了モデル", () => {
  it("リリースから12か月以上か提供終了なら対象", () => {
    const m = target(sampleData());
    expect(isRetiring({ ...m, releaseDate: "2025-10-11" }, "2026-10-11", gates)).toBe(true);
    expect(isRetiring({ ...m, releaseDate: "2025-10" }, "2026-10-11", gates)).toBe(true);
    expect(isRetiring({ ...m, releaseDate: "2025-10-12" }, "2026-10-11", gates)).toBe(false);
    expect(isRetiring({ ...m, releaseDate: undefined }, "2026-10-11", gates)).toBe(false);
    expect(isRetiring({ ...m, providerStatus: "deprecated" }, "2026-10-11", gates)).toBe(true);
    expect(isRetiring({ ...m, deprecationDate: "2026-10-11" }, "2026-10-11", gates)).toBe(true);
  });

  it("単価が欠落しても止めずに記録する", () => {
    const prev = sampleData(), next = structuredClone(prev);
    target(prev).releaseDate = target(next).releaseDate = "2025-08-07";
    const rule = target(next).prices[0];
    delete rule.input; delete rule.provenance?.input;
    const r = evaluateGates(prev, next, gates);
    expect(r.stop).toEqual([]);
    expect(r.notes).toEqual([expect.stringContaining("古い・提供終了モデルの単価が0・欠落(掲載から外す): gpt-6.1-sol@openai:global standard input")]);
  });

  it("単価が0になった価格ルールを外し、ルールが残らなければ掲載から外す", () => {
    const prev = sampleData(), next = structuredClone(prev);
    target(prev).providerStatus = target(next).providerStatus = "deprecated";
    const count = target(next).prices.length;
    target(next).prices[0].input = 0;
    expect(dropZeroedRetiring(prev, next, gates)).toHaveLength(1);
    expect(target(next).prices).toHaveLength(count - 1);
    expect(evaluateGates(prev, next, gates).stop).toEqual([]);

    for (const r of target(next).prices) r.input = 0;
    expect(dropZeroedRetiring(prev, next, gates).at(-1)).toContain("掲載から外した: gpt-6.1-sol@openai:global");
    expect(next.models.some((m) => m.id === "gpt-6.1-sol@openai:global")).toBe(false);
    expect(evaluateGates(prev, next, gates).stop).toEqual([]);
  });

  it("新しいモデルは従来どおり止める", () => {
    const prev = sampleData(), next = structuredClone(prev);
    target(next).prices[0].input = 0;
    expect(dropZeroedRetiring(prev, next, gates)).toEqual([]);
    expect(evaluateGates(prev, next, gates).stop).toHaveLength(1);
  });
});

describe("checkFx", () => {
  it("±5%以内なら使う", () => expect(checkFx(158, 160, gates).ok).toBe(true));
  it("±5%超なら前回値", () => expect(checkFx(158, 170, gates).ok).toBe(false));
  it("取得失敗なら前回値", () => expect(checkFx(158, undefined, gates).ok).toBe(false));
});
