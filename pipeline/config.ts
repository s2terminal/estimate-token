import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Category, Platform } from "../shared/types.ts";

export interface RecommendationGroup {
  category: Category;
  vendor: string;
  /** 用途が同じモデル系列にだけ一致する正規表現 */
  pattern: string;
}

export interface Catalog {
  providers: Record<string, Platform>;
  modes: string[];
  excludeKeyPatterns: string[];
  vendors: { pattern: string; vendor: string }[];
  names: Record<string, string>;
  recommendations: RecommendationGroup[];
}

export interface Gates {
  fetch: { minSizeRatio: number };
  count: { maxDropPct: number };
  price: { stopChangePct: number; noteChangePct: number };
  crosscheck: { mismatchPct: number };
  fx: { maxChangePct: number };
  newModel: { days: number; openrouterRecentDays: number };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const load = <T>(name: string): T => parse(readFileSync(`${root}config/${name}`, "utf8")) as T;

export const loadCatalog = (): Catalog => load<Catalog>("catalog.yaml");
export const loadGates = (): Gates => load<Gates>("gates.yaml");
export const ROOT = root;
