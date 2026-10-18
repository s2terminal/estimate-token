import { createHash } from "node:crypto";
import type { PriceData } from "../shared/types.ts";

/** 割引の確認日は適用判定日を進めるため含める。他の取得時刻・未採用レコードは除外。 */
export const contentHash = (data: PriceData) => createHash("sha256").update(JSON.stringify({
  models: data.models, fx: data.sources.fx.rate, fxStale: !!data.sources.fx.stale,
  commit: data.sources.litellm.commit, liteStale: !!data.sources.litellm.stale,
  modelsDevStale: !!data.sources.modelsDev?.stale,
  promotions: data.sources.promotions,
})).digest("hex");
