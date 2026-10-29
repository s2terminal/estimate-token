import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { LiteLLMData } from "./select.ts";
import type { OpenRouterModel } from "./crosscheck.ts";
import { MODELS_DEV_URL, normalizeModelsDev, validateCatalog, type ModelsDevCatalog } from "./models-dev.ts";
import { GEMINI_PRICING_URL, parsePromotions, type Promotions } from "./promotions.ts";

const LITELLM_REPO = "BerriAI/litellm";
const LITELLM_PATH = "model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const FX_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY";
export interface Fetched<T> { data: T; bytes: number; fetchedAt: string; stale?: boolean; }
export interface ModelsDevFetched extends Fetched<ModelsDevCatalog> {
  url: string; sha256: string; etag?: string; counts: Record<string, number>;
}
export interface FetchResult {
  litellm: (Fetched<LiteLLMData> & { commit: string; records?: number }) | null;
  modelsDev: ModelsDevFetched | null;
  openrouter: Fetched<OpenRouterModel[]> | null;
  fx: { rate: number; date: string } | null;
  warnings: string[];
  rejected: string[];
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
function save(path: string, text: string) { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); }
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { "user-agent": "estimate-token-pipeline", ...headers }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (bytes(text) > 50 * 1024 * 1024) throw new Error(`${url}: 応答が50MiBを超過`);
  return { text, etag: res.headers.get("etag") ?? undefined };
}
async function latestCommit(): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  try {
    const { text } = await get(`https://api.github.com/repos/${LITELLM_REPO}/commits?path=${LITELLM_PATH}&per_page=1`, {
      accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}),
    });
    return (JSON.parse(text) as { sha: string }[])[0]?.sha ?? null;
  } catch { return null; }
}

/** `User-agent: *` グループの規則で判定する（RFC 9309: 最長一致、同長ならAllow優先）。グループがなければ不許可。 */
export function robotsAllows(robots: string, url: string): boolean {
  const { pathname, search } = new URL(url), target = pathname + search;
  const rules: { allow: boolean; pattern: string }[] = [];
  let found = false, inGroup = false, inAgents = false;
  for (const raw of robots.split(/\r?\n/)) {
    const m = raw.replace(/#.*/, "").match(/^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      if (!inAgents) inGroup = false;
      inAgents = true;
      if (m[2] === "*") inGroup = found = true;
      continue;
    }
    inAgents = false;
    if (inGroup && (key === "allow" || key === "disallow") && m[2]) rules.push({ allow: key === "allow", pattern: m[2] });
  }
  if (!found) return false;
  const matches = (pattern: string) =>
    new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")).test(target);
  const best = rules.filter((r) => matches(r.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length || Number(b.allow) - Number(a.allow))[0];
  return best?.allow ?? true;
}

/** 公式割引は古い取得値へ戻さず、確認できなければ更新全体を中断する。 */
export async function fetchPromotions(rawDir?: string): Promise<{ body: string; promotions: Promotions }> {
  const url = `${GEMINI_PRICING_URL}?hl=en`;
  const { text: robots } = await get("https://ai.google.dev/robots.txt");
  if (!robotsAllows(robots, url)) throw new Error("Gemini料金表のrobots.txtを再確認してください");
  const { text: body } = await get(url, { accept: "text/markdown, text/html;q=0.9" });
  const promotions = parsePromotions(body, new Date().toISOString().slice(0, 10));
  if (rawDir) {
    mkdirSync(rawDir, { recursive: true });
    save(`${rawDir}/gemini-pricing.txt`, body);
    save(`${rawDir}/gemini-pricing.meta.json`, JSON.stringify({ checkedOn: promotions.source.checkedOn }));
  }
  return { body, promotions };
}

export function readPromotions(rawDir: string): Promotions {
  return parsePromotions(read(rawDir, "gemini-pricing.txt"), JSON.parse(read(rawDir, "gemini-pricing.meta.json")).checkedOn);
}
const liteData = (text: string): LiteLLMData => {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length ||
      !Object.entries(data).every(([key, v]) => key === "sample_spec" || !!v && typeof v === "object" && !Array.isArray(v)))
    throw new Error("LiteLLM: 価格JSONの構造が不正");
  return data as LiteLLMData;
};
const read = (dir: string, name: string) => readFileSync(`${dir}/${name}`, "utf8");
function readLite(dir: string): FetchResult["litellm"] {
  const text = read(dir, "litellm.json");
  const meta = existsSync(`${dir}/litellm.meta.json`) ? JSON.parse(read(dir, "litellm.meta.json")) : { commit: "unknown", fetchedAt: "" };
  return { ...meta, data: liteData(text), bytes: bytes(text), records: Object.keys(liteData(text)).length };
}
function readModelsDev(dir: string): ModelsDevFetched {
  const text = read(dir, "models-dev.catalog.json");
  const data = validateCatalog(JSON.parse(text)), sha256 = hash(text);
  const meta = existsSync(`${dir}/models-dev.meta.json`) ? JSON.parse(read(dir, "models-dev.meta.json")) : { fetchedAt: "" };
  if (meta.sha256 && meta.sha256 !== sha256) throw new Error("models.dev: rawのSHA-256がメタ情報と不一致");
  return { ...meta, data, url: MODELS_DEV_URL, sha256, bytes: bytes(text), counts: normalizeModelsDev(data).counts };
}
export function readRaw(rawDir: string): FetchResult {
  const result: FetchResult = { litellm: null, modelsDev: null, openrouter: null, fx: null, warnings: [], rejected: [] };
  for (const source of ["litellm", "modelsDev", "openrouter", "fx"] as const) {
    try {
      switch (source) {
        case "litellm": result.litellm = readLite(rawDir); break;
        case "modelsDev": result.modelsDev = readModelsDev(rawDir); break;
        case "openrouter": {
          const text = read(rawDir, "openrouter.json");
          const data = JSON.parse(text).data;
          if (!Array.isArray(data)) throw new Error("data配列がない");
          result.openrouter = { data, bytes: bytes(text), fetchedAt: "" }; break;
        }
        case "fx": {
          const j = JSON.parse(read(rawDir, "fx.json"));
          if (!(typeof j.rates?.JPY === "number" && Number.isFinite(j.rates.JPY) && j.rates.JPY > 0)) throw new Error("JPYが不正");
          result.fx = { rate: j.rates.JPY, date: j.date }; break;
        }
      }
    } catch (e) { result.warnings.push(`${source}: 保存済みrawを利用できない: ${(e as Error).message}`); }
  }
  return result;
}
interface FetchOptions {
  minSizeRatio?: number;
  previous?: { litellm?: { bytes?: number; records?: number }; modelsDev?: { bytes?: number; counts?: Record<string, number> } };
}
/** 検証を通過した応答だけを保存。失敗したソースは前回の正常rawを日時・stale付きで維持する。 */
export async function fetchAll(rawDir: string, options: FetchOptions = {}): Promise<FetchResult> {
  mkdirSync(rawDir, { recursive: true });
  const cached = readRaw(rawDir);
  const result: FetchResult = { litellm: null, modelsDev: null, openrouter: null, fx: null, warnings: [], rejected: [] };
  const ratio = options.minSizeRatio ?? 0.6;
  function checkSize(label: string, previous: number | undefined, current: number) {
    if (previous && current < previous * ratio) {
      const reason = `${label}: 取得サイズ/件数が前回の${Math.round(current / previous * 100)}%に急減`;
      result.rejected.push(reason); throw new Error(reason);
    }
  }
  await Promise.all((["litellm", "modelsDev", "openrouter", "fx"] as const).map(async source => {
    try {
      if (source === "litellm") {
        const sha = await latestCommit(), commit = sha ?? "main";
        if (!sha) result.warnings.push("LiteLLMのコミットSHAを取得できなかったためmainを使用");
        const { text } = await get(`https://raw.githubusercontent.com/${LITELLM_REPO}/${commit}/${LITELLM_PATH}`);
        const data = liteData(text), records = Object.keys(data).length;
        checkSize("LiteLLM bytes", options.previous?.litellm?.bytes ?? cached.litellm?.bytes, bytes(text));
        checkSize("LiteLLM records", options.previous?.litellm?.records ?? cached.litellm?.records, records);
        const meta = { commit, fetchedAt: new Date().toISOString(), bytes: bytes(text), records };
        save(`${rawDir}/litellm.json`, text); save(`${rawDir}/litellm.meta.json`, JSON.stringify(meta));
        result.litellm = { ...meta, data };
      } else if (source === "modelsDev") {
        const { text, etag } = await get(MODELS_DEV_URL);
        const data = validateCatalog(JSON.parse(text)), counts = normalizeModelsDev(data).counts;
        checkSize("models.dev bytes", options.previous?.modelsDev?.bytes ?? cached.modelsDev?.bytes, bytes(text));
        const previous = options.previous?.modelsDev?.counts ?? cached.modelsDev?.counts;
        for (const [provider, count] of Object.entries(previous ?? {})) checkSize(`models.dev ${provider}`, count, counts[provider] ?? 0);
        const meta = { url: MODELS_DEV_URL, fetchedAt: new Date().toISOString(), sha256: hash(text), bytes: bytes(text), counts, ...(etag ? { etag } : {}) };
        save(`${rawDir}/models-dev.catalog.json`, text); save(`${rawDir}/models-dev.meta.json`, JSON.stringify(meta));
        result.modelsDev = { ...meta, data };
      } else if (source === "openrouter") {
        const { text } = await get(OPENROUTER_URL), data = JSON.parse(text).data;
        if (!Array.isArray(data)) throw new Error("OpenRouter: data配列がない");
        save(`${rawDir}/openrouter.json`, text);
        result.openrouter = { data, bytes: bytes(text), fetchedAt: new Date().toISOString() };
      } else {
        const { text } = await get(FX_URL), j = JSON.parse(text);
        if (!(typeof j.rates?.JPY === "number" && Number.isFinite(j.rates.JPY) && j.rates.JPY > 0)) throw new Error("為替JPYが不正");
        save(`${rawDir}/fx.json`, text); result.fx = { rate: j.rates.JPY, date: j.date };
      }
    } catch (e) {
      result.warnings.push(`${source} の取得に失敗: ${(e as Error).message}`);
      if (source === "litellm" && cached.litellm) result.litellm = { ...cached.litellm, stale: true };
      if (source === "modelsDev" && cached.modelsDev) result.modelsDev = { ...cached.modelsDev, stale: true };
      if (source === "openrouter" && cached.openrouter) result.openrouter = { ...cached.openrouter, stale: true };
      // 為替の取得失敗はrun.tsで前回の公開値へフォールバックする。
      if (source !== "fx" && result[source]) result.warnings.push(`${source}: 前回の正常rawを使用 (${result[source]!.fetchedAt})`);
    }
  }));
  return result;
}
