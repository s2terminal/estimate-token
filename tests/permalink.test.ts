import { describe, expect, it } from "vitest";
import { b64urlEncode, decodeState, encodeState } from "../src/lib/permalink.ts";
import { defaultState } from "../src/lib/state.ts";

const base = defaultState({ llm: ["a@openai:global"], img: ["b@gemini-api:global"] });

describe("permalink", () => {
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

  it("OpenAIの幅・高さ・画質を共有し、旧e2リンクは既定の条件で復元する", () => {
    const s = structuredClone(base);
    s.t = "img";
    s.img = { n: 100, r: "4K", w: 3840, h: 2160, q: "max" };
    expect(decodeState(encodeState(s), base)!.state.img).toEqual(s.img);
    const old = "e2" + b64urlEncode(JSON.stringify({ img: { n: 500, r: "2K" } }));
    expect(decodeState(old, base)!.state.img).toEqual({ n: 500, r: "2K", w: 1024, h: 1024, q: "medium" });
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
