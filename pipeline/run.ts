/* 日次更新パイプライン: fetch → select → normalize → cross-check → validate → diff
   使い方: npm run pipeline [-- --offline] [-- --force-stop]
   出力: public/data/latest.json(中身が変わったときだけ)、out/report.md(GitHub 上限内)、out/report-full.md、out/gate.json */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PriceData } from "../shared/types.ts";
import { ROOT, loadCatalog, loadGates, loadModelsDevPolicy } from "./config.ts";
import { assembleModels } from "./assemble.ts";
import { contentHash } from "./content.ts";
import { crossCheck } from "./crosscheck.ts";
import { diffData, diffMarkdown, fitMarkdown } from "./diff.ts";
import { fetchAll, readRaw, fetchPromotions, readPromotions } from "./fetch.ts";
import { unsupportedImageModels } from "./image-tokens.ts";
import { applyPromotions } from "./promotions.ts";
import { applyRecommendations } from "./recommend.ts";
import { checkFx, evaluateGates } from "./validate.ts";

const args = new Set(process.argv.slice(2));
const option = (name: string, fallback: string) => process.argv.find(a => a.startsWith(name + "="))?.slice(name.length + 1) ?? fallback;
const DATA_PATH = option("--data", `${ROOT}public/data/latest.json`);
const OUT_DIR = option("--out", `${ROOT}out`);
const RAW_DIR = option("--raw", `${ROOT}raw`);

/** 日次実行は JST の朝なので、スナップショット日は JST の日付にする */
const jstDate = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

async function main() {
  const now = new Date();
  const today = jstDate(now);
  const catalog = loadCatalog();
  const gates = loadGates();
  const prev: PriceData | null = existsSync(DATA_PATH) ? JSON.parse(readFileSync(DATA_PATH, "utf8")) : null;

  const src = args.has("--offline") ? readRaw(RAW_DIR) : await fetchAll(RAW_DIR, { minSizeRatio: gates.fetch.minSizeRatio, previous: prev?.sources });
  const promotions = args.has("--offline") ? readPromotions(RAW_DIR) : (await fetchPromotions(RAW_DIR)).promotions;
  const notes = [...src.warnings];

  const { models, unparsed, frozen, skipped, notes: mergeNotes } = assembleModels(src, prev, catalog, loadModelsDevPolicy(), today);
  notes.push(...mergeNotes);
  const cc = src.openrouter
    ? crossCheck(models, src.openrouter.data, { mismatchPct: gates.crosscheck.mismatchPct, recentDays: gates.newModel.openrouterRecentDays, now })
    : { mismatches: [], candidates: [] };

  applyPromotions(models, promotions);

  const prevById = new Map((prev?.models ?? []).map((m) => [m.id, m]));
  for (const m of models) {
    m.firstSeen = prevById.get(m.id)?.firstSeen ?? today;
    if (!src.openrouter && prevById.get(m.id)?.needsReview) m.needsReview = true;
  }
  applyRecommendations(models, catalog.recommendations, today);
  const unsupported = unsupportedImageModels(models, prev?.models);
  notes.push(...unsupported.added.map((m) => `画像トークン換算未対応の新モデル: ${m.id} — ${m.reason}`));

  const fxCheck = checkFx(prev?.sources.fx.rate, src.fx?.rate, gates);
  if (!fxCheck.ok) notes.push(`${fxCheck.reason}。為替は前回値を使用`);
  const fx =
    fxCheck.ok || !prev
      ? { pair: "USDJPY" as const, rate: src.fx?.rate ?? 150, date: src.fx?.date ?? today, ...(src.fx ? {} : { stale: true }) }
      : { ...prev.sources.fx, stale: true };

  const next: PriceData = {
    schemaVersion: 1,
    snapshot: today,
    generatedAt: now.toISOString(),
    baseline: prev?.baseline ?? today,
    sources: {
      litellm: frozen ? { ...prev!.sources.litellm, stale: true } : {
        commit: src.litellm!.commit, fetchedAt: src.litellm!.fetchedAt, bytes: src.litellm!.bytes,
        records: src.litellm!.records, ...(src.litellm!.stale ? { stale: true } : {}),
      },
      ...((frozen && prev!.sources.modelsDev) ? { modelsDev: { ...prev!.sources.modelsDev!, stale: true } } :
        src.modelsDev ? { modelsDev: {
          url: src.modelsDev.url, fetchedAt: src.modelsDev.fetchedAt, sha256: src.modelsDev.sha256,
          bytes: src.modelsDev.bytes, counts: src.modelsDev.counts,
          ...(src.modelsDev.etag ? { etag: src.modelsDev.etag } : {}),
          ...(src.modelsDev.stale ? { stale: true } : {}),
        } } : {}),
      openrouter: src.openrouter ? { fetchedAt: src.openrouter.fetchedAt, bytes: src.openrouter.bytes, ...(src.openrouter.stale ? { stale: true } : {}) } :
        { ...(prev?.sources.openrouter ?? { fetchedAt: "" }), stale: true },
      fx,
      promotions: [promotions.source],
    },
    models,
  };

  const gate = evaluateGates(prev, next, gates);
  gate.stop.push(...src.rejected);
  gate.notes.unshift(...notes);
  if (args.has("--force-stop")) gate.stop.push("テスト用の強制フラグ(--force-stop)");

  const changed = !prev || contentHash(prev) !== contentHash(next);
  const extra = {
    mismatches: cc.mismatches.map((id) => `照合の不一致(要確認): ${id}`),
    candidates: cc.candidates.map((c) => `${c.family}(${c.platform})`),
    unparsed,
    unsupportedImages: unsupported.all.map((m) => `${m.id} — ${m.reason}`),
    skipped,
  };
  const diff = diffData(prev, next);
  const report = diffMarkdown(diff, gate, next, extra);

  mkdirSync(OUT_DIR, { recursive: true });
  if (changed) {
    mkdirSync(`${ROOT}public/data`, { recursive: true });
    writeFileSync(DATA_PATH, JSON.stringify(next, null, 1) + "\n");
  }
  // report.md は Issue コメント・PR 本文に使うので GitHub の上限に収め、全文は artifact に残す
  const env = process.env;
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  writeFileSync(`${OUT_DIR}/report.md`, fitMarkdown(report, runUrl));
  writeFileSync(`${OUT_DIR}/report-full.md`, diffMarkdown(diff, gate, next, extra, { detail: true }));
  const status = gate.stop.length ? "stop" : "pass";
  const hasNotes = gate.notes.length + cc.mismatches.length + cc.candidates.length > 0;
  writeFileSync(`${OUT_DIR}/gate.json`, JSON.stringify({ status, changed, hasNotes, ...gate }, null, 2));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\nchanged=${changed}\nnotes=${hasNotes}\nsnapshot=${today}\n`);

  console.log(`snapshot=${today} models=${models.length} (review ${cc.mismatches.length}, candidates ${cc.candidates.length}) changed=${changed} status=${status}`);
  for (const s of gate.stop) console.log(`STOP: ${s}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
