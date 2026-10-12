import { describe, expect, it } from "vitest";
import type { PriceData } from "../shared/types.ts";
import { loadGates } from "../pipeline/config.ts";
import { checkFx, evaluateGates, validateSchema } from "../pipeline/validate.ts";
import { sampleData } from "./helpers.ts";

const gates = loadGates();
const clone = (d: PriceData): PriceData => structuredClone(d);
const target = (d: PriceData) => d.models.find((m) => m.id === "gpt-6.1-sol@openai:global")!;

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
    d.models.find((m) => m.family === "gpt-image-2")!.prices[0].imageOutput = NaN;
    expect(validateSchema(d)).toHaveLength(1);
  });
});

describe("evaluateGates", () => {
  it("前回と同じなら止めない", () => {
    const d = sampleData();
    expect(evaluateGates(d, clone(d), gates)).toEqual({ stop: [], notes: [] });
  });

  it("件数が半減したら止める", () => {
    const prev = sampleData();
    const next = clone(prev);
    next.models = next.models.slice(0, Math.floor(next.models.length / 2));
    expect(evaluateGates(prev, next, gates).stop.some((s) => s.startsWith("件数の急減"))).toBe(true);
  });

  it("単価が0になったら止める", () => {
    const prev = sampleData();
    const next = clone(prev);
    target(next).prices[0].input = 0;
    expect(evaluateGates(prev, next, gates).stop.some((s) => s.startsWith("単価が0になった"))).toBe(true);
  });

  it("単価が欠落したら止める", () => {
    const prev = sampleData();
    const next = clone(prev);
    delete target(next).prices[0].output;
    expect(evaluateGates(prev, next, gates).stop.some((s) => s.startsWith("単価が0になった"))).toBe(true);
  });
  it("画像出力トークン単価の大幅変更と欠落も公開を止める", () => {
    const prev = sampleData(), next = clone(prev);
    const rule = next.models.find((m) => m.family === "gpt-image-2")!.prices[0];
    rule.imageOutput = 60;
    expect(evaluateGates(prev, next, gates).stop.some((s) => s.includes("imageOutput"))).toBe(true);
    delete rule.imageOutput;
    expect(evaluateGates(prev, next, gates).stop.some((s) => s.startsWith("単価が0になった") && s.includes("imageOutput"))).toBe(true);
  });

  it("±50%超の変化は止める", () => {
    const prev = sampleData();
    const next = clone(prev);
    target(next).prices[0].input = 3.2; // +60%
    expect(evaluateGates(prev, next, gates).stop.some((s) => s.startsWith("大きな値変わり"))).toBe(true);
  });

  it("±10〜50%は公開して記録する", () => {
    const prev = sampleData();
    const next = clone(prev);
    target(next).prices[0].input = 2.4; // +20%
    const r = evaluateGates(prev, next, gates);
    expect(r.stop).toEqual([]);
    expect(r.notes).toHaveLength(1);
  });

  it("取得サイズが前回の50%未満なら止める", () => {
    const prev = sampleData();
    const next = clone(prev);
    next.sources.litellm.bytes = 40_000;
    expect(evaluateGates(prev, next, gates).stop.some((s) => s.startsWith("取得失敗"))).toBe(true);
  });
});

describe("checkFx", () => {
  it("±5%以内なら使う", () => expect(checkFx(158, 160, gates).ok).toBe(true));
  it("±5%超なら前回値", () => expect(checkFx(158, 170, gates).ok).toBe(false));
  it("取得失敗なら前回値", () => expect(checkFx(158, undefined, gates).ok).toBe(false));
});
