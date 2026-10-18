import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAll, readRaw } from "../../pipeline/fetch.ts";
import { assembleModels } from "../../pipeline/assemble.ts";
import { loadCatalog, loadModelMappings } from "../../pipeline/config.ts";
import { MODELS_DEV_URL } from "../../pipeline/models-dev.ts";
import { catalogOf, offering } from "../support/models-dev.ts";
import { litellmSample, sampleData } from "../support/fixtures.ts";
import { createHash } from "node:crypto";

let dir: string;
const data = () => catalogOf({ openai: [offering("gpt-6.1-sol")] });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function seed() {
  const text = JSON.stringify(data());
  writeFileSync(join(dir, "litellm.json"), JSON.stringify(litellmSample()));
  writeFileSync(join(dir, "litellm.meta.json"), JSON.stringify({ commit: "previous-commit", fetchedAt: "2026-10-12T00:00:00Z" }));
  writeFileSync(join(dir, "models-dev.catalog.json"), text);
  writeFileSync(join(dir, "models-dev.meta.json"), JSON.stringify({ fetchedAt: "2026-10-12T00:00:00Z", sha256: sha(text) }));
}
function mockFetch(fail: "modelsDev" | "litellm" | "all" | null = null, body: unknown = data()) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (fail === "all" || fail === "modelsDev" && url === MODELS_DEV_URL || fail === "litellm" && url.includes("raw.githubusercontent.com"))
      throw new Error("simulated source outage");
    const value = url === MODELS_DEV_URL ? body :
      url.includes("/commits?") ? [{ sha: "new-commit" }] :
      url.includes("raw.githubusercontent.com") ? litellmSample() :
      url.includes("openrouter") ? { data: [] } : { date: "2026-10-18", rates: { JPY: 158.25 } };
    return new Response(JSON.stringify(value), { headers: { ETag: '"fixture-etag"' } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "estimate-models-dev-")); });
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe("models.devの取得・前回値維持", () => {
  it("catalogを1回取得し、UTF-8 bytes・SHA・ETag・provider別件数を記録する", async () => {
    const fn = mockFetch();
    const result = await fetchAll(dir);
    expect(fn.mock.calls.filter(([url]) => String(url) === MODELS_DEV_URL)).toHaveLength(1);
    const text = readFileSync(join(dir, "models-dev.catalog.json"), "utf8");
    expect(result.modelsDev).toMatchObject({ url: MODELS_DEV_URL, sha256: sha(text), bytes: Buffer.byteLength(text), etag: '"fixture-etag"', counts: { openai: 1, models: 1 } });
    expect(readRaw(dir).modelsDev?.sha256).toBe(sha(text));
  });
  it.each(["modelsDev", "litellm"] as const)("%sの障害時は正常rawと元の取得日時をstale付きで維持する", async source => {
    seed(); mockFetch(source);
    const result = await fetchAll(dir);
    expect(result[source]).toMatchObject({ stale: true, fetchedAt: "2026-10-12T00:00:00Z" });
    expect(result[source === "modelsDev" ? "litellm" : "modelsDev"]?.stale).toBeUndefined();
  });
  it("壊れた応答で保存済みスナップショットを上書きしない", async () => {
    seed(); const before = readFileSync(join(dir, "models-dev.catalog.json"), "utf8");
    mockFetch(null, { providers: [] });
    const result = await fetchAll(dir);
    expect(result.modelsDev?.stale).toBe(true);
    expect(readFileSync(join(dir, "models-dev.catalog.json"), "utf8")).toBe(before);
  });
  it.each([
    { bytes: 10000000 }, { bytes: 1, counts: { openai: 20 } },
  ])("サイズ・ソース別件数の急減を拒否して前回値を維持する", async previous => {
    seed(); mockFetch();
    const result = await fetchAll(dir, { previous: { modelsDev: previous }, minSizeRatio: 0.5 });
    expect(result.rejected.some(n => n.includes("急減"))).toBe(true);
    expect(result.modelsDev?.stale).toBe(true);
    expect(result.modelsDev?.fetchedAt).toBe("2026-10-12T00:00:00Z");
  });
  it("任意ソースがないrawでもオフライン再実行できる", () => {
    writeFileSync(join(dir, "litellm.json"), JSON.stringify(litellmSample()));
    const result = readRaw(dir);
    expect(result.litellm).not.toBeNull();
    expect(result.modelsDev).toBeNull();
    expect(result.openrouter).toBeNull();
    expect(result.fx).toBeNull();
  });
  it("rawとメタ情報の内容ハッシュが一致しない場合は使用しない", () => {
    seed();
    writeFileSync(join(dir, "models-dev.meta.json"), JSON.stringify({ sha256: "0".repeat(64) }));
    expect(readRaw(dir).modelsDev).toBeNull();
  });
  it("正常rawがないソース障害時は公開済みの料金・採用元をそのまま維持する", () => {
    const prev = sampleData();
    prev.sources.modelsDev = { url: MODELS_DEV_URL, fetchedAt: "2026-10-12T00:00:00Z", sha256: "a".repeat(64), bytes: 1000 };
    const src = readRaw(dir);
    const result = assembleModels(src, prev, loadCatalog(), loadModelMappings(), "2026-10-18");
    expect(result.frozen).toBe(true);
    expect(result.models).toEqual(prev.models);
    expect(() => assembleModels(src, null, loadCatalog(), loadModelMappings(), "2026-10-18")).toThrow("更新できません");
  });
  it("LiteLLMで廃止済みの確認済みモデルを別ソースの欠損statusで復活させない", () => {
    seed();
    const src = readRaw(dir);
    src.litellm!.data = { "gpt-6.1-sol": {
      litellm_provider: "openai", mode: "chat", input_cost_per_token: 0.000002, output_cost_per_token: 0.00001,
      deprecation_date: "2026-10-01",
    } };
    const result = assembleModels(src, null, loadCatalog(), loadModelMappings(), "2026-10-18");
    expect(result.models.some(m => m.id === "gpt-6.1-sol@openai:global")).toBe(false);
    expect(result.notes.some(n => n.includes("既知の廃止"))).toBe(true);
  });
});
