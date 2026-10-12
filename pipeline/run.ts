/* 日次更新パイプライン: fetch → select → normalize → cross-check → validate → diff
   使い方: npm run pipeline [-- --offline] [-- --force-stop]
   出力: public/data/latest.json(中身が変わったときだけ)、out/report.md、out/gate.json */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { PriceData } from "../shared/types.ts";
import { ROOT, loadCatalog, loadGates } from "./config.ts";
import { crossCheck } from "./crosscheck.ts";
import { diffData, diffMarkdown } from "./diff.ts";
import { fetchAll, readRaw } from "./fetch.ts";
import { unsupportedImageModels } from "./image-tokens.ts";
import { normalize } from "./normalize.ts";
import { select } from "./select.ts";
import { checkFx, evaluateGates } from "./validate.ts";

const args = new Set(process.argv.slice(2));
const DATA_PATH = `${ROOT}public/data/latest.json`;
const OUT_DIR = `${ROOT}out`;
const RAW_DIR = `${ROOT}raw`;

/** 日次実行は JST の朝なので、スナップショット日は JST の日付にする */
const jstDate = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

const contentHash = (d: PriceData) =>
  createHash("sha256").update(JSON.stringify({ models: d.models, fx: d.sources.fx.rate, commit: d.sources.litellm.commit })).digest("hex");

async function main() {
  const now = new Date();
  const today = jstDate(now);
  const catalog = loadCatalog();
  const gates = loadGates();
  const prev: PriceData | null = existsSync(DATA_PATH) ? JSON.parse(readFileSync(DATA_PATH, "utf8")) : null;

  const src = args.has("--offline") ? readRaw(RAW_DIR) : await fetchAll(RAW_DIR);
  const notes = [...src.warnings];

  const selected = select(src.litellm.data, catalog, today);
  const { models, unparsed } = normalize(selected, catalog);
  const cc = src.openrouter
    ? crossCheck(models, src.openrouter.data, { mismatchPct: gates.crosscheck.mismatchPct, recentDays: gates.newModel.openrouterRecentDays, now })
    : { mismatches: [], candidates: [] };

  const prevById = new Map((prev?.models ?? []).map((m) => [m.id, m]));
  for (const m of models) m.firstSeen = prevById.get(m.id)?.firstSeen ?? today;
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
      litellm: { commit: src.litellm.commit, fetchedAt: src.litellm.fetchedAt, bytes: src.litellm.bytes },
      openrouter: { fetchedAt: src.openrouter?.fetchedAt ?? "", ...(src.openrouter ? { bytes: src.openrouter.bytes } : {}) },
      fx,
    },
    models,
  };

  const gate = evaluateGates(prev, next, gates);
  gate.notes.unshift(...notes);
  if (args.has("--force-stop")) gate.stop.push("テスト用の強制フラグ(--force-stop)");

  const changed = !prev || contentHash(prev) !== contentHash(next);
  const report = diffMarkdown(diffData(prev, next), gate, next, {
    mismatches: cc.mismatches.map((id) => `照合の不一致(要確認): ${id}`),
    candidates: cc.candidates.map((c) => `${c.family}(${c.platform})`),
    unparsed,
    unsupportedImages: unsupported.all.map((m) => `${m.id} — ${m.reason}`),
  });

  mkdirSync(OUT_DIR, { recursive: true });
  if (changed) {
    mkdirSync(`${ROOT}public/data`, { recursive: true });
    writeFileSync(DATA_PATH, JSON.stringify(next, null, 1) + "\n");
  }
  writeFileSync(`${OUT_DIR}/report.md`, report);
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
