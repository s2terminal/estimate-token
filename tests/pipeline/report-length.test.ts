import { describe, expect, it } from "vitest";
import { fitMarkdown, GITHUB_BODY_LIMIT } from "../../pipeline/diff.ts";

describe("レポートを GitHub の本文上限に収める", () => {
  it("上限以内ならそのまま返す", () => {
    expect(fitMarkdown("## 価格更新\n- なし\n")).toBe("## 価格更新\n- なし\n");
  });
  it("上限を超えたら行単位で切り詰め、全文の置き場所を添える", () => {
    const md = ["## 価格更新", ...Array.from({ length: 5000 }, (_, i) => `- モデル${i} releaseDate: 不明 → "2026-09"`)].join("\n");
    const out = fitMarkdown(md, "https://github.com/o/r/actions/runs/1");
    expect([...out].length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
    expect(out.startsWith("## 価格更新\n- モデル0 ")).toBe(true);
    expect(out).toContain("https://github.com/o/r/actions/runs/1");
    expect(out).toContain("out/report-full.md");
    const body = out.slice(0, out.indexOf("\n\n---\n"));
    for (const line of body.split("\n").slice(1)) expect(line).toMatch(/^- モデル\d+ releaseDate: 不明 → "2026-09"$/);
  });
});
