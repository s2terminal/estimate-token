import { createHash } from "node:crypto";
import type { PriceData } from "../shared/types.ts";

/** 取得時刻や未採用レコードの変更だけでは価格コミットを作らない。 */
export const contentHash = (data: PriceData) => createHash("sha256").update(JSON.stringify({
  models: data.models, fx: data.sources.fx.rate, fxStale: !!data.sources.fx.stale,
  commit: data.sources.litellm.commit, liteStale: !!data.sources.litellm.stale,
  modelsDevStale: !!data.sources.modelsDev?.stale,
})).digest("hex");
