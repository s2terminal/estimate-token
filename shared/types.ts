/* 価格データの型。パイプライン(pipeline/)と画面(src/)で共有する。
   単価は USD / 1M tokens、画像は USD / 枚。 */

export type Platform = "openai" | "anthropic" | "gemini-api" | "vertex-ai" | "bedrock" | "azure";
export type Category = "llm" | "image";
export type Tier = "standard" | "batch" | "flex" | "priority";
export type ModelStatus = "active" | "deprecated";

export interface PriceRule {
  tier: Tier;
  /** 長文価格の開始点。この値を超える入力tokensで適用(0 は通常価格) */
  minPromptTokens: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  /** 画像1枚あたり(解像度指定なし) */
  perImage?: number;
  /** 解像度別の1枚あたり("1K" "2K" "4K" など) */
  perImageByRes?: Record<string, number>;
  /** 期間限定価格用。MVPでは常に空 */
  validFrom?: string;
  validTo?: string;
  promo?: boolean;
}

export interface ModelSource {
  litellm?: string;
  aliases?: string[];
  url?: string;
}

export interface Model {
  id: string;
  family: string;
  name: string;
  vendor: string;
  platform: Platform;
  region: string;
  category: Category;
  contextWindow?: number;
  deprecationDate?: string;
  firstSeen: string;
  status: ModelStatus;
  featured?: boolean;
  /** 別ソースとの照合で差が大きかった(画面に「要確認」を出す)。差の値は公開しない */
  needsReview?: boolean;
  prices: PriceRule[];
  sources: ModelSource[];
}

export interface PriceData {
  schemaVersion: 1;
  snapshot: string;
  generatedAt: string;
  /** 初回取り込み日。これより後の firstSeen を「新着」とみなす */
  baseline: string;
  sources: {
    litellm: { commit: string; fetchedAt: string; bytes?: number };
    /** 照合にだけ使う。値は公開しない */
    openrouter: { fetchedAt: string; bytes?: number };
    fx: { pair: "USDJPY"; rate: number; date: string; stale?: boolean };
  };
  models: Model[];
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  openai: "OpenAI API",
  anthropic: "Claude API",
  "gemini-api": "Gemini API",
  "vertex-ai": "Vertex AI",
  bedrock: "Amazon Bedrock",
  azure: "Azure",
};

export const REGION_LABEL: Record<string, string> = {
  global: "",
  regional: "リージョン内",
  us: "US",
  eu: "EU",
  jp: "日本",
  apac: "APAC",
  au: "オーストラリア",
  "us-gov": "US GovCloud",
};
