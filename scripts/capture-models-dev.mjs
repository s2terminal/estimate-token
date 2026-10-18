// 公開APIから取得したスナップショットを、テストに必要なレコードへ限定する。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const url = "https://models.dev/catalog.json";
const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
const raw = await response.text(), catalog = JSON.parse(raw);
if (!catalog.models || !catalog.providers) throw new Error("catalog root is invalid");
const featured = JSON.parse(readFileSync("public/data/latest.json", "utf8")).models.filter(m => m.featured);
const ids = new Set(featured.flatMap(m => [m.family, ...m.sources.map(s => s.litellm?.replace(/^(?:gemini|vertex_ai|bedrock_converse|bedrock|azure_ai|azure)\//, ""))]).filter(Boolean));
const required = ["gpt-6.1-sol", "gpt-4o", "gpt-4o-2024-05-13", "gpt-4o-2024-08-06", "gpt-5.6-luna", "gpt-5.3-codex-spark", "gpt-image-1.5", "gemini-omni-flash-preview", "gemini-2.5-computer-use-preview-10-2025"];
required.forEach(id => ids.add(id));
const selected = { models: {}, providers: {} };
for (const providerId of ["openai", "anthropic", "google", "google-vertex", "google-vertex-anthropic", "amazon-bedrock", "azure", "azure-cognitive-services"]) {
  const provider = catalog.providers[providerId];
  if (!provider) continue;
  const models = {};
  for (const [id, model] of Object.entries(provider.models)) {
    if (!ids.has(id) && !/sonnet-4-6|sonnet-5-5|haiku-5-5|opus-5-5|flash-image|pro-image/.test(id)) continue;
    models[id] = model;
    if (model.canonical_model_id && catalog.models[model.canonical_model_id]) selected.models[model.canonical_model_id] = catalog.models[model.canonical_model_id];
  }
  selected.providers[providerId] = { ...provider, models };
}
for (const [id, model] of Object.entries(catalog.models))
  if (ids.has(id.split("/").slice(1).join("/")) || /nano-banana-2[.-]1|gpt-image-2[.-]5/.test(id)) selected.models[id] = model;
const meta = { url, fetchedAt: new Date().toISOString(), sha256: createHash("sha256").update(raw).digest("hex"), bytes: Buffer.byteLength(raw),
  etag: response.headers.get("etag"), extraction: "Selected original API records; unchanged field values",
  counts: { models: Object.keys(catalog.models).length, ...Object.fromEntries(Object.entries(selected.providers).map(([id]) => [id, Object.keys(catalog.providers[id].models).length])) } };
const fixture = JSON.stringify(selected, null, 2) + "\n";
meta.fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
meta.fixtureBytes = Buffer.byteLength(fixture);
mkdirSync("raw", { recursive: true });
writeFileSync("raw/models-dev.catalog.json", raw);
writeFileSync("raw/models-dev.meta.json", JSON.stringify(meta, null, 2) + "\n");
mkdirSync("tests/fixtures", { recursive: true });
for (const [name, data] of [["models-dev.catalog.json", selected], ["models-dev.meta.json", meta]]) {
  const text = JSON.stringify(data, null, 2) + "\n";
  writeFileSync("tests/fixtures/" + name, text);
}
console.log("models.dev live API verified", JSON.stringify(meta));
