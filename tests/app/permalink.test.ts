import { describe, expect, it } from "vitest";
import { b64urlEncode, decodeState, encodeState } from "../../src/lib/permalink.ts";
import { defaultState } from "../../src/lib/state.ts";

const base = defaultState({ llm: ["a@openai:global"], img: ["b@gemini-api:global"] });

describe("permalink", () => {
  it("割引は初期値・設定のない旧リンク・不正な値で加味しない", () => {
    expect(defaultState().promo).toBe(false);
    for (const promo of [undefined, "true", 1, null]) {
      const hash = "e2" + b64urlEncode(JSON.stringify({ promo }));
      expect(decodeState(hash, { ...base, promo: true })!.state.promo).toBe(false);
    }
  });

  it.each([false, true])("割引設定 %s を共有リンクから復元する", (promo) => {
    for (const t of ["llm", "img"] as const) {
      const state = { ...base, t, promo };
      expect(decodeState(encodeState(state), base)!.state.promo).toBe(promo);
    }
  });

  it("書き出しと読み戻しで状態が一致する", () => {
    const s = structuredClone(base);
    s.t = "llm";
    s.fx = 150;
    s.cur = "USD";
    s.unit = "1K";
    s.cm = "log";
    s.llm = { n: 12345, i: 3000, o: 800, c: true, h: 40, tier: "flex" };
    s.sel.llm = ["gpt-6.1-sol@openai:global", "claude-sonnet-5-5@anthropic:global"];
    const hash = encodeState(s);
    expect(hash.startsWith("e2")).toBe(true);
    const d = decodeState("#" + hash, base)!;
    expect(d.state).toEqual(s);
    expect(d.selTabs).toEqual(["llm"]);
    expect(d.warning).toBeUndefined();
  });

  it("リンクに入っていないタブの選択は既定のまま", () => {
    const s = structuredClone(base);
    s.sel.llm = ["x@openai:global"];
    const d = decodeState(encodeState(s), base)!;
    expect(d.state.sel.img).toEqual(base.sel.img);
  });

  it("解像度と画質を共有し、旧e2リンクも保存された解像度で復元する", () => {
    const s = structuredClone(base);
    s.t = "img";
    s.img = { n: 100, i: 300, r: "4K", q: "max" };
    expect(decodeState(encodeState(s), base)!.state.img).toEqual(s.img);
    const old = "e2" + b64urlEncode(JSON.stringify({ img: { n: 500, r: "2K" } }));
    expect(decodeState(old, base)!.state.img).toEqual({ n: 500, i: 1000, r: "2K", q: "medium" });
  });

  it("旧リンクの個別サイズは引き継がず、固定サイズへの変更を知らせる", () => {
    const old = "e2" + b64urlEncode(JSON.stringify({ t: "img", img: { n: 500, r: "2K", w: 1024, h: 1536, q: "high" } }));
    const decoded = decodeState(old, base)!;
    expect(decoded.state.img).toEqual({ n: 500, i: 1000, r: "2K", q: "high" });
    expect(decoded.warning).toContain("2048×2048");
    const serialized = JSON.parse(atob(encodeState(decoded.state).slice(2).replace(/-/g, "+").replace(/_/g, "/")));
    expect(serialized.img).toEqual({ n: 500, i: 1000, r: "2K", q: "high" });
  });

  it("旧リンクのサイズが解像度の固定サイズと同じなら警告しない", () => {
    const old = "e2" + b64urlEncode(JSON.stringify({ img: { n: 500, r: "4K", w: 3840, h: 2160 } }));
    expect(decodeState(old, base)!.warning).toBeUndefined();
  });

  it("旧版(e1)のリンクも入力値を読める", () => {
    const e1 = {
      v: 1, s: "2026-10-10", t: "dec", fx: 158, cur: "USD", unit: "1K", p: true, d: "2026-10-10", cm: "ratio",
      llm: { n: 10000, i: 10000, o: 1500, c: true, h: 60, tier: "standard" },
      img: { n: 500, r: "2K" }, dec: { n: 1, i: 1 },
      sel: { llm: ["oa-sol", "an-sonnet"] },
    };
    const d = decodeState("#e1" + b64urlEncode(JSON.stringify(e1)), base)!;
    expect(d.state).toMatchObject({ t: "llm", fx: null, cur: "USD", unit: "1K", cm: "ratio", img: { n: 500, r: "2K" } });
    expect(d.state.llm).toEqual(e1.llm);
    expect(d.state.sel).toEqual(base.sel);
    expect(d.warning).toBeTruthy();
  });

  it("壊れたリンクは null", () => {
    expect(decodeState("#e2!!!", base)).toBeNull();
    expect(decodeState("#zz", base)).toBeNull();
  });

  it("おかしな値は既定値や範囲内に直す", () => {
    const hash = "e2" + b64urlEncode(JSON.stringify({ t: "x", llm: { n: -5, h: 300, tier: "gold" }, unit: 3 }));
    const d = decodeState(hash, base)!;
    expect(d.state.t).toBe("llm");
    expect(d.state.llm).toMatchObject({ n: 0, h: 100, tier: "standard" });
    expect(d.state.unit).toBe("1M");
  });
});
