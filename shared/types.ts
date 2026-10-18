/* 価格データの型。パイプライン(pipeline/)と画面(src/)で共有する。
   単価は USD / 1M tokens、画像は USD / 枚。 */

export type Platform = "openai" | "anthropic" | "gemini-api" | "vertex-ai" | "bedrock" | "azure";
export type Category = "llm" | "image";
export type Tier = "standard" | "batch" | "flex" | "priority";
export type ModelStatus = "active" | "deprecated";

export type PriceField = "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "perImage" | "imageOutput" | "perImageByRes";
export interface ValueSource {
  source: "litellm" | "models.dev";
  modelId: string;
  providerId?: string;
  url: string;
  checkedAt?: string;
  references?: string[];
}
export interface PriceRule {
  provenance?: Partial<Record<PriceField, ValueSource>>;
  comparedSources?: Partial<Record<PriceField, ValueSource[]>>;
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
  /** 画像出力トークン単価(USD / 1M image output tokens)。1枚単価とは別 */
  imageOutput?: number;
  /** 期間限定価格用。日付は両端を含む */
  validFrom?: string;
  validTo?: string;
  promo?: boolean;
  /** sources.promotions の出典ID */
  source?: string;
}

export interface PromotionSource {
  id: string;
  title: string;
  author: string;
  url: string;
  license: "CC-BY-4.0";
  licenseUrl: string;
  checkedOn: string;
  modifications: string;
}

export interface ModelSource {
  modelsDev?: { providerId: string; modelId: string; status?: "alpha" | "beta" | "deprecated" };
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
  /** 互換フィールド。従来どおり入力上限を表す。 */
  contextWindow?: number;
  inputLimit?: number;
  totalContext?: number;
  outputLimit?: number;
  canonicalModelId?: string;
  modalities?: { input: string[]; output: string[] };
  reasoning?: boolean;
  toolCall?: boolean;
  metadataSources?: Partial<Record<"inputLimit" | "totalContext" | "outputLimit" | "modalities" | "reasoning" | "toolCall", ValueSource>>;
  providerStatus?: "alpha" | "beta" | "deprecated";
  recommendationEligible?: boolean;
  releaseDateSource?: ValueSource & { precision: "month" | "day" | "timestamp" };
  /** ソースに明記されたリリース日/日時。firstSeen やモデルIDの日付とは別 */
  releaseDate?: string;
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
    litellm: { commit: string; fetchedAt: string; bytes?: number; records?: number; stale?: boolean };
    modelsDev?: { url: string; fetchedAt: string; sha256: string; bytes: number; etag?: string; stale?: boolean; counts?: Record<string, number> };
    /** 照合にだけ使う。値は公開しない */
    openrouter: { fetchedAt: string; bytes?: number; stale?: boolean };
    fx: { pair: "USDJPY"; rate: number; date: string; stale?: boolean };
    promotions?: PromotionSource[];
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
  "global-standard": "Global Standard",
  regional: "リージョン内",
  us: "US",
  eu: "EU",
  jp: "日本",
  apac: "APAC",
  au: "オーストラリア",
  "us-gov": "US GovCloud",
};
