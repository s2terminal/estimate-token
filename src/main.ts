import "./style.css";
import { type Model, PLATFORM_LABEL, type PriceData } from "../shared/types.ts";
import { type CalcOk, type CalcResult, calcImage, calcLlm } from "./lib/calc.ts";
import { esc } from "./lib/format.ts";
import { type Filter, categoryOf, isFiltering, modelFlags, regionLabel, visibleModels, where } from "./lib/models.ts";
import { decodeState, encodeState } from "./lib/permalink.ts";
import { PRESETS, TAB_LABEL, type State, type Tab, defaultState } from "./lib/state.ts";
import { type ChartCtx, type ChartRow, SERIES, chartNoteText, chartSVG, tooltipHTML } from "./ui/chart.ts";
import { $ } from "./ui/dom.ts";
import { renderResults } from "./ui/results.ts";

const MAX_LIST = 200;

let DATA: PriceData;
let S: State;
let filter: Filter = { q: "", vendor: "", platform: "", region: "" };
let lastChartRows: ChartRow[] = [];

/* ===== 表示用の補助 ===== */
const fx = () => S.fx ?? DATA.sources.fx.rate;
const byId = () => new Map(DATA.models.map((m) => [m.id, m]));
const tabModels = () => DATA.models.filter((m) => m.category === categoryOf(S.t));

function defaultSelection() {
  const pick = (cat: string) => DATA.models.filter((m) => m.category === cat && m.featured).map((m) => m.id);
  return { llm: pick("llm"), img: pick("image") };
}

/* ===== 結果 ===== */
function calc(m: Model): CalcResult {
  const opts = { asOf: DATA.snapshot, promo: S.promo };
  return S.t === "img" ? calcImage(m, S.img, opts) : calcLlm(m, S.llm, opts);
}
function results() {
  const map = byId();
  const rows = S.sel[S.t].map((id) => map.get(id)).filter((m): m is Model => !!m).map(calc);
  const ok = rows.filter((x): x is CalcOk => !x.na).sort((a, b) => a.usd - b.usd);
  const na = rows.filter((x) => x.na);
  return { ok, na };
}

/* ===== 描画 ===== */
function render() {
  $("snapId").textContent = DATA.snapshot;
  $("fxChip").textContent = String(fx());
  $("fxDate").textContent = S.fx != null ? "(手入力)" : `(${DATA.sources.fx.date}${DATA.sources.fx.stale ? "・前回値" : ""})`;
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.t)));
  $("fs-llm").hidden = S.t !== "llm";
  $("fs-img").hidden = S.t !== "img";
  $("hitRow").hidden = !S.llm.c;
  segSet("imgRes", S.img.r);
  segSet("cur", S.cur);
  segSet("unit", S.unit);
  segSet("cmode", S.cm);
  const { ok, na } = results();
  renderResults(DATA, S, ok, na);
  renderChart(ok);
  const link = location.href.split("#")[0] + "#" + encodeState(S);
  $<HTMLInputElement>("permalink").value = link;
  history.replaceState(null, "", "#" + encodeState(S));
  $("selCount").textContent = `${S.sel[S.t].length}件を選択中`;
}
function segSet(id: string, v: string) {
  document.querySelectorAll<HTMLButtonElement>(`#${id} button`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
}
function syncInputs() {
  const set = (id: string, v: string | number) => ($<HTMLInputElement>(id).value = String(v));
  set("llmN", S.llm.n);
  set("llmIn", S.llm.i);
  set("llmOut", S.llm.o);
  set("llmTier", S.llm.tier);
  $<HTMLInputElement>("llmCache").checked = S.llm.c;
  set("llmHit", S.llm.h);
  set("imgN", S.img.n);
  set("imgIn", S.img.i ?? 0);
  set("imgQuality", S.img.q ?? "medium");
  set("fx", fx());
  set("promo", String(S.promo));
}

/* ===== モデルの選択(検索・絞り込み) ===== */
function fillFilterOptions() {
  const ms = tabModels();
  const opts = (id: string, all: string, values: [string, string][]) => {
    const el = $<HTMLSelectElement>(id);
    const cur = el.value;
    el.innerHTML = `<option value="">${all}</option>` + values.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    el.value = values.some(([v]) => v === cur) ? cur : "";
  };
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  opts("fVendor", "開発元: すべて", uniq(ms.map((m) => m.vendor)).map((v) => [v, v]));
  opts("fPlatform", "経由: すべて", uniq(ms.map((m) => m.platform)).map((p) => [p, PLATFORM_LABEL[p as Model["platform"]]]));
  opts("fRegion", "リージョン: すべて", uniq(ms.map((m) => m.region)).map((r) => [r, regionLabel(r) || "グローバル"]));
  filter = { q: $<HTMLInputElement>("mSearch").value, vendor: $<HTMLSelectElement>("fVendor").value, platform: $<HTMLSelectElement>("fPlatform").value, region: $<HTMLSelectElement>("fRegion").value };
}

function shownModels() {
  return visibleModels(tabModels(), DATA, filter, new Set(S.sel[S.t]));
}

function renderModelList() {
  const sel = new Set(S.sel[S.t]);
  const all = shownModels();
  const ms = all.slice(0, MAX_LIST);
  $("mHint").textContent = isFiltering(filter)
    ? `${all.length}件が一致${all.length > MAX_LIST ? `(先頭${MAX_LIST}件を表示。条件を足して絞り込んでください)` : ""}`
    : `おすすめと選択中のモデルを表示中(全${tabModels().length}件)。検索や絞り込みで追加できます`;
  const groups = new Map<string, Model[]>();
  for (const m of ms) groups.set(m.platform, [...(groups.get(m.platform) ?? []), m]);
  $("mlist").innerHTML =
    [...groups]
      .map(
        ([p, list]) =>
          `<div class="mgroup">${esc(PLATFORM_LABEL[p as Model["platform"]])}</div>` +
          list
            .map((m) => {
              const tags = modelFlags(m, DATA)
                .map((f) => `<span class="tag ${f.k === "warn" ? "warn" : ""}">${esc(f.t.replace(/\(.*\)$/, ""))}</span>`)
                .join("");
              return `<label><input type="checkbox" data-id="${esc(m.id)}" ${sel.has(m.id) ? "checked" : ""}>${esc(m.name)} <span class="sub">${esc(regionLabel(m.region))}</span>${tags}</label>`;
            })
            .join(""),
      )
      .join("") || `<p class="mmeta">一致するモデルはありません。</p>`;
}

/* ===== グラフ ===== */
const chartCtx = (): ChartCtx => ({ cm: S.cm, multi: S.cm === "mix", cur: S.cur, fx: fx() });
function renderChart(ok: CalcOk[]) {
  const box = $("chartBox");
  lastChartRows = ok.map((x) => ({ name: x.m.name, sub: `${x.m.vendor} ・ ${where(x.m)}`, plat: where(x.m), total: x.usd, parts: x.parts }));
  $("chartTitle").textContent = `${TAB_LABEL[S.t]}の価格差`;
  $("chartPanel").hidden = !lastChartRows.length;
  if (!lastChartRows.length) {
    box.innerHTML = "";
    return;
  }
  const ctx = chartCtx();
  $("legend").innerHTML = ctx.multi
    ? (S.t === "img" ? (["in", "out"] as const) : (["in", "cache", "out"] as const)).map((k) => `<span><i style="background:var(--${SERIES[k].c})"></i>${SERIES[k].label}</span>`).join("")
    : "";
  $("legend").hidden = !ctx.multi;
  const pad = parseFloat(getComputedStyle(box).paddingLeft) || 0;
  const W = Math.max(300, Math.round(box.clientWidth - pad * 2) || 700);
  box.innerHTML = chartSVG(lastChartRows, W, ctx);
  $("chartNote").textContent = chartNoteText(S.cm, ctx.multi);
}
function showTip(i: number, clientX: number, clientY: number) {
  const r = lastChartRows[i];
  if (!r) return;
  const tip = $("chartTip"), panel = $("chartPanel");
  tip.innerHTML = tooltipHTML(r, lastChartRows, chartCtx());
  tip.hidden = false;
  const pr = panel.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = clientX - pr.left + 14, y = clientY - pr.top + 14;
  if (x + tw > pr.width - 8) x = Math.max(8, clientX - pr.left - tw - 14);
  if (y + th > pr.height - 8) y = Math.max(8, clientY - pr.top - th - 14);
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}

/* ===== トースト・コピー ===== */
let toastTimer: number | undefined;
function toast(msg: string, ms = 5000) {
  $("toast").textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ($("toast").textContent = ""), ms);
}

/* ===== イベント ===== */
function bind() {
  const num = (id: string, min = 0) => {
    const v = Number($<HTMLInputElement>(id).value);
    return Number.isFinite(v) ? Math.max(min, v) : min;
  };
  $("form").addEventListener("submit", (e) => e.preventDefault());
  $("form").addEventListener("input", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("#modelsBox")) return;
    S.llm = {
      n: num("llmN"),
      i: num("llmIn"),
      o: num("llmOut"),
      tier: $<HTMLSelectElement>("llmTier").value as State["llm"]["tier"],
      c: $<HTMLInputElement>("llmCache").checked,
      h: Math.min(100, num("llmHit")),
    };
    S.img.n = num("imgN");
    S.img.i = num("imgIn");
    S.img.q = $<HTMLSelectElement>("imgQuality").value as State["img"]["q"];
    S.promo = $<HTMLSelectElement>("promo").value === "true";
    if (el.id === "fx") {
      const v = num("fx", 1);
      S.fx = v === DATA.sources.fx.rate ? null : v;
    }
    render();
  });
  $("fxReset").addEventListener("click", () => {
    S.fx = null;
    syncInputs();
    render();
  });
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      S.t = b.dataset.tab as Tab;
      fillFilterOptions();
      renderModelList();
      render();
    }),
  );
  $("presets").innerHTML = Object.entries(PRESETS)
    .map(([k, p]) => `<button type="button" data-preset="${k}">${esc(p.label)}</button>`)
    .join("");
  $("presets").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-preset]");
    if (!b) return;
    S.llm = { ...PRESETS[b.dataset.preset!].v };
    syncInputs();
    render();
    toast(`「${b.textContent}」の想定を入れました`);
  });
  const segs: [string, (v: string) => void][] = [
    ["imgRes", (v) => (S.img.r = v)],
    ["cur", (v) => (S.cur = v as State["cur"])],
    ["unit", (v) => (S.unit = v as State["unit"])],
    ["cmode", (v) => (S.cm = v as State["cm"])],
  ];
  for (const [id, fn] of segs)
    document.querySelectorAll<HTMLButtonElement>(`#${id} button`).forEach((b) =>
      b.addEventListener("click", () => {
        fn(b.dataset.v!);
        render();
      }),
    );

  const onFilter = () => {
    fillFilterOptions();
    renderModelList();
  };
  $("mSearch").addEventListener("input", onFilter);
  ["fVendor", "fPlatform", "fRegion"].forEach((id) => $(id).addEventListener("change", onFilter));
  $("mlist").addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    const id = el.dataset.id;
    if (!id) return;
    const set = new Set(S.sel[S.t]);
    if (el.checked) set.add(id);
    else set.delete(id);
    S.sel[S.t] = [...set];
    render();
  });
  $("selShown").addEventListener("click", () => {
    const set = new Set(S.sel[S.t]);
    shownModels().slice(0, MAX_LIST).forEach((m) => set.add(m.id));
    S.sel[S.t] = [...set];
    renderModelList();
    render();
  });
  $("selNone").addEventListener("click", () => {
    S.sel[S.t] = [];
    renderModelList();
    render();
  });
  $("copyLink").addEventListener("click", async () => {
    const input = $<HTMLInputElement>("permalink");
    try {
      await navigator.clipboard.writeText(input.value);
      toast("共有リンクをコピーしました");
    } catch {
      input.select();
      toast("自動でコピーできませんでした。選択されたリンクをコピーしてください");
    }
  });

  const box = $("chartBox");
  box.addEventListener("pointermove", (e) => {
    const g = (e.target as Element).closest<SVGGElement>(".c-row");
    if (g) showTip(+g.dataset.i!, e.clientX, e.clientY);
    else $("chartTip").hidden = true;
  });
  box.addEventListener("pointerleave", () => ($("chartTip").hidden = true));
  box.addEventListener("focusin", (e) => {
    const g = (e.target as Element).closest<SVGGElement>(".c-row");
    if (!g) return;
    const b = g.getBoundingClientRect();
    showTip(+g.dataset.i!, b.left + b.width * 0.4, b.top + b.height);
  });
  box.addEventListener("focusout", () => ($("chartTip").hidden = true));
  new ResizeObserver(() => lastChartRows.length && renderChart(results().ok)).observe(box);
}

/* ===== 起動 ===== */
async function boot() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/latest.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = (await res.json()) as PriceData;
  } catch (e) {
    const el = $("loadError");
    el.hidden = false;
    el.innerHTML = `<p><strong>価格データを読み込めませんでした。</strong>時間をおいて再読み込みしてください(${esc((e as Error).message)})。</p>`;
    return;
  }

  const base = defaultState(defaultSelection());
  S = base;
  if (location.hash.length > 1) {
    const d = decodeState(location.hash, base);
    if (!d) toast("リンクを読み込めませんでした。初期値で表示しています", 8000);
    else {
      S = d.state;
      const map = byId();
      const missing = d.selTabs.flatMap((t) => S.sel[t].filter((id) => !map.has(id)));
      for (const t of d.selTabs) S.sel[t] = S.sel[t].filter((id) => map.has(id));
      if (missing.length) toast(`このモデルは現在のデータにありません: ${missing.join(", ")}`, 10000);
      else if (d.warning) toast(d.warning, 8000);
    }
  }

  const fxs = DATA.sources.fx;
  const md = DATA.sources.modelsDev;
  $("srcNote").innerHTML = `データ: LiteLLM <code>${esc(DATA.sources.litellm.commit.slice(0, 12))}</code>${DATA.sources.litellm.stale ? "（前回値）" : ""}${md ? `、<a href="https://models.dev/catalog.json" target="_blank" rel="noopener">models.dev</a> <code>${esc(md.sha256.slice(0, 12))}</code>（取得 ${esc(md.fetchedAt)}${md.stale ? "・前回値" : ""}）` : ""}、為替 ${esc(fxs.rate)} 円(${esc(fxs.date)})、生成 ${esc(DATA.generatedAt)}。対象 ${DATA.models.length} モデル。<a href="${import.meta.env.BASE_URL}licenses/models-dev.txt">models.dev MIT License</a>。`;
  $("promoSources").innerHTML = (DATA.sources.promotions ?? []).map((s) =>
    `割引料金の出典: ${esc(s.author)}「<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>」(<a href="${esc(s.licenseUrl)}" target="_blank" rel="noopener">CC BY 4.0</a>)。確認日 ${esc(s.checkedOn)}。変更内容: ${esc(s.modifications)}`
  ).join("<br>");
  $("app").hidden = false;
  if (window.innerWidth > 900) ($("modelsBox") as HTMLDetailsElement).open = true;
  bind();
  syncInputs();
  fillFilterOptions();
  renderModelList();
  render();
}

boot();
