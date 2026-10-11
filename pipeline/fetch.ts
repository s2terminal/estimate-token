import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { LiteLLMData } from "./select.ts";
import type { OpenRouterModel } from "./crosscheck.ts";

const LITELLM_REPO = "BerriAI/litellm";
const LITELLM_PATH = "model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const FX_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY";

export interface Fetched<T> {
  data: T;
  bytes: number;
  fetchedAt: string;
}
export interface FetchResult {
  litellm: Fetched<LiteLLMData> & { commit: string };
  openrouter: Fetched<OpenRouterModel[]> | null;
  fx: { rate: number; date: string } | null;
  warnings: string[];
}

async function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "estimate-token-pipeline", ...headers }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** LiteLLM の価格JSONを更新した最新コミットの SHA。取れなければ null */
async function latestCommit(): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  try {
    const body = await get(`https://api.github.com/repos/${LITELLM_REPO}/commits?path=${LITELLM_PATH}&per_page=1`, {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    });
    const sha = (JSON.parse(body) as { sha: string }[])[0]?.sha;
    return sha ?? null;
  } catch {
    return null;
  }
}

/** 3つのソースを取得して rawDir に生データを置く。LiteLLM の失敗だけは例外にする */
export async function fetchAll(rawDir: string): Promise<FetchResult> {
  mkdirSync(rawDir, { recursive: true });
  const warnings: string[] = [];
  const now = () => new Date().toISOString();

  const sha = await latestCommit();
  if (!sha) warnings.push("LiteLLM のコミットSHAを取得できなかったため main を使用");
  const ref = sha ?? "main";
  const litellmText = await get(`https://raw.githubusercontent.com/${LITELLM_REPO}/${ref}/${LITELLM_PATH}`);
  writeFileSync(`${rawDir}/litellm.json`, litellmText);
  const litellm = { data: JSON.parse(litellmText) as LiteLLMData, bytes: litellmText.length, fetchedAt: now(), commit: ref };
  writeFileSync(`${rawDir}/litellm.meta.json`, JSON.stringify({ commit: ref, fetchedAt: litellm.fetchedAt }));

  let openrouter: FetchResult["openrouter"] = null;
  try {
    const text = await get(OPENROUTER_URL);
    writeFileSync(`${rawDir}/openrouter.json`, text);
    openrouter = { data: (JSON.parse(text) as { data: OpenRouterModel[] }).data, bytes: text.length, fetchedAt: now() };
  } catch (e) {
    warnings.push(`OpenRouter の取得に失敗: ${(e as Error).message}`);
  }

  let fx: FetchResult["fx"] = null;
  try {
    const text = await get(FX_URL);
    writeFileSync(`${rawDir}/fx.json`, text);
    const j = JSON.parse(text) as { date: string; rates: { JPY: number } };
    fx = { rate: j.rates.JPY, date: j.date };
  } catch (e) {
    warnings.push(`為替の取得に失敗: ${(e as Error).message}`);
  }
  return { litellm, openrouter, fx, warnings };
}

/** rawDir に置いた生データから読み直す(--offline 用) */
export function readRaw(rawDir: string): FetchResult {
  const read = (f: string) => readFileSync(`${rawDir}/${f}`, "utf8");
  const lt = read("litellm.json");
  let meta = { commit: "unknown", fetchedAt: new Date().toISOString() };
  try {
    meta = JSON.parse(read("litellm.meta.json"));
  } catch {
    /* メタ情報がなくても読める */
  }
  const or = read("openrouter.json");
  const fx = JSON.parse(read("fx.json")) as { date: string; rates: { JPY: number } };
  return {
    litellm: { data: JSON.parse(lt), bytes: lt.length, fetchedAt: meta.fetchedAt, commit: meta.commit },
    openrouter: { data: JSON.parse(or).data, bytes: or.length, fetchedAt: meta.fetchedAt },
    fx: { rate: fx.rates.JPY, date: fx.date },
    warnings: [],
  };
}
