import { requiresImageConversion, resolveImageTokenProfile } from "../shared/image-token-config.ts";
import type { Model, Platform } from "../shared/types.ts";
import type { RecommendationGroup } from "./config.ts";

/** 日付はソースの明示値だけを受け取る。モデルID、取り込み日からは推測しない。 */
export function releaseDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return;
  const day = value.slice(0, 10);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return;
  return value;
}

const DIRECT: Record<string, Platform> = { OpenAI: "openai", Anthropic: "anthropic", Google: "gemini-api" };
const PLATFORMS: Platform[] = ["openai", "anthropic", "gemini-api", "vertex-ai", "bedrock", "azure"];
const version = (m: Model) => (m.family.match(/\d+/g) ?? []).map(Number);
const compareVersion = (a: Model, b: Model) => {
  const av = version(a), bv = version(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (bv[i] ?? 0) - (av[i] ?? 0);
    if (diff) return diff;
  }
  return a.id.localeCompare(b.id);
};
const dateOf = (m: Model) => {
  const date = releaseDate(m.releaseDate);
  return date ? Date.parse(date) : undefined;
};

function usable(m: Model): boolean {
  if (m.status !== "active") return false;
  const r = m.prices.find((r) => r.tier === "standard" && r.minPromptTokens === 0);
  if (!r) return false;
  const valid = (n?: number) => n != null && Number.isFinite(n) && n >= 0;
  if (m.category === "llm") return valid(r.input) && valid(r.output);
  if (requiresImageConversion(m, r)) return valid(r.imageOutput) && !!resolveImageTokenProfile(m.family, undefined, m.platform).profile;
  return valid(r.perImage) || !!r.perImageByRes && Object.values(r.perImageByRes).some(valid);
}

/** 全モデルは残し、用途ごとに1件だけ初期選択する。呼び直しても同じ結果になる。 */
export function applyRecommendations(models: Model[], groups: RecommendationGroup[]): void {
  for (const m of models) delete m.featured;
  for (const group of groups) {
    const pattern = new RegExp(group.pattern);
    const candidates = models.filter((m) => m.category === group.category && m.vendor === group.vendor && pattern.test(m.family) && usable(m));
    // 同じモデルは直販 → global → 固定の提供先順で代表を決める。
    // 提供先への追加日が新しくても別の新モデルとはみなさない。
    candidates.sort((a, b) =>
      Number(b.platform === DIRECT[b.vendor]) - Number(a.platform === DIRECT[a.vendor]) ||
      Number(b.region === "global") - Number(a.region === "global") ||
      PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) || a.id.localeCompare(b.id));
    const families = new Map<string, Model>();
    for (const m of candidates) {
      const key = m.family.replace(/\./g, "-");
      if (!families.has(key)) families.set(key, m);
    }
    // 日時がある候補同士は日時で選ぶ。日時不明の後継を永久に外さないよう、
    // 不明候補の最新とはバージョンで比較する。2段階にして比較の推移律を保つ。
    const values = [...families.values()];
    const dated = values.filter(m => dateOf(m) != null)
      .sort((a, b) => dateOf(b)! - dateOf(a)! || compareVersion(a, b))[0];
    const undated = values.filter(m => dateOf(m) == null).sort(compareVersion)[0];
    const winner = dated && undated ? (compareVersion(dated, undated) <= 0 ? dated : undated) : dated ?? undated;
    if (winner) winner.featured = true;
  }
}
