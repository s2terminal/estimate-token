import type { Model, PriceRule, ValueSource } from "../../shared/types.ts";
import { esc } from "./format.ts";

const sourceLabel = (s: ValueSource) => s.source === "models.dev" ? "models.dev" : "LiteLLM";
function link(s: ValueSource, label: string, fields: string[] = []) {
  const title = [fields.join("・"), [s.providerId, s.modelId].filter(Boolean).join("/")].filter(Boolean).join(": ");
  return /^https:\/\//.test(s.url)
    ? `<a href="${esc(s.url)}" title="${esc(title)}" target="_blank" rel="noopener">${esc(label)}</a>`
    : esc(label);
}
/** 価格採用元と日付の出典を別々に示す。古いJSONは従来のsourcesへフォールバックする。 */
export function sourceCell(model: Model, rule?: PriceRule): string {
  const labels: Record<string, string> = { input: "入力", output: "出力", cacheRead: "キャッシュ読取", cacheWrite: "キャッシュ書込", cacheWrite1h: "1時間キャッシュ書込", perImage: "画像", perImageByRes: "解像度別画像", imageOutput: "画像出力" };
  const adopted = (rule ? [rule] : model.prices).flatMap(r => Object.values(r.provenance ?? {})).filter((s): s is ValueSource => !!s);
  if (!adopted.length) for (const s of model.sources) {
    if (s.litellm) adopted.push({ source: "litellm", modelId: s.litellm, url: s.url ?? "" });
    else if (s.modelsDev) adopted.push({ source: "models.dev", ...s.modelsDev, url: s.url ?? "https://models.dev/catalog.json" });
  }
  const seen = new Set<string>();
  const prices = adopted.filter(s => {
    const key = `${s.source}|${s.providerId ?? ""}|${s.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(s => {
    const fields = (rule ? [rule] : model.prices).flatMap(r => Object.entries(r.provenance ?? {}))
      .filter(([, ref]) => ref?.source === s.source && ref.modelId === s.modelId && ref.providerId === s.providerId)
      .map(([field]) => labels[field] ?? field);
    return link(s, sourceLabel(s), [...new Set(fields)]);
  }).join(" / ") || "—";
  const date = model.releaseDate && model.releaseDateSource
    ? `<br>リリース ${esc(model.releaseDate)}${model.releaseDateSource.precision === "month" ? " (年月)" : ""}: ${link(model.releaseDateSource, sourceLabel(model.releaseDateSource))}`
    : model.releaseDate ? `<br>リリース ${esc(model.releaseDate)}` : "";
  return `${prices}${date}`;
}
