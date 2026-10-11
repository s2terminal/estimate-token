import "./style.css";
import { type Model, PLATFORM_LABEL, type PriceData, type PriceRule } from "../shared/types.ts";
import { type CalcOk, type CalcResult, TIER_LABEL, calcImage, calcLlm } from "./lib/calc.ts";
import { esc, int, money as fmtMoney, sig, unitLabel, unitPrice as fmtUnit } from "./lib/format.ts";
import { type Filter, categoryOf, isFiltering, modelFlags, regionLabel, visibleModels, where } from "./lib/models.ts";
import { decodeState, encodeState } from "./lib/permalink.ts";
import { PRESETS, type State, type Tab, defaultState } from "./lib/state.ts";
import { type ChartCtx, type ChartRow, SERIES, chartNoteText, chartSVG, tooltipHTML } from "./ui/chart.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const TABNAME: Record<Tab, string> = { llm: "言語モデル", img: "画像生成" };
const MAX_LIST = 200;

let DATA: PriceData;
let S: State;
let filter: Filter = { q: "", vendor: "", platform: "", region: "" };
let lastChartRows: ChartRow[] = [];

/* ===== 表示用の補助 ===== */
const fx = () => S.fx ?? DATA.sources.fx.rate;
const money = (usd: number) => fmtMoney(usd, S.cur, fx());
const unitPrice = (per1M?: number) => fmtUnit(per1M, S.unit, S.cur, fx());
const byId = () => new Map(DATA.models.map((m) => [m.id, m]));
const tabModels = () => DATA.models.filter((m) => m.category === categoryOf(S.t));

function defaultSelection() {
  const pick = (cat: string) => DATA.models.filter((m) => m.category === cat && m.featured).map((m) => m.id);
  return { llm: pick("llm"), img: pick("image") };
}

/* ===== 結果 ===== */
function calc(m: Model): CalcResult {
  return S.t === "img" ? calcImage(m, S.img) : calcLlm(m, S.llm);
}
function results() {
  const map = byId();
  const rows = S.sel[S.t].map((id) => map.get(id)).filter((m): m is Model => !!m).map(calc);
  const ok = rows.filter((x): x is CalcOk => !x.na).sort((a, b) => a.usd - b.usd);
  const na = rows.filter((x) => x.na);
  return { ok, na };
}
function premiseText() {
  if (S.t === "llm") {
    const L = S.llm;
    return `月 ${int(L.n)} 回 × 入力 ${int(L.i)} / 出力 ${int(L.o)} tokens/回 ・ ${TIER_LABEL[L.tier]} ・ キャッシュ ${L.c ? L.h + "%" : "なし"}`;
  }
  return `月 ${int(S.img.n)} 枚 ・ 解像度 ${S.img.r} ・ OpenAI ${S.img.w ?? 1024}×${S.img.h ?? 1024} / ${S.img.q ?? "medium"}(画像出力のみ)`;
}
const conditionText = () => `為替 1 USD = ${fx()} 円 ・ 価格データ ${DATA.snapshot} ・ 税抜`;
const allFlags = (x: CalcResult) => [...modelFlags(x.m, DATA), ...x.flags];
const flagHtml = (x: CalcResult) => allFlags(x).map((f) => `<span class="flag ${f.k}">${esc(f.t)}</span>`).join("");

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
  renderSummary(ok);
  renderTable(ok, na);
  renderChart(ok);
  renderUnitTable();
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
  set("imgWidth", S.img.w ?? 1024);
  set("imgHeight", S.img.h ?? 1024);
  set("imgQuality", S.img.q ?? "medium");
  set("fx", fx());
}

function renderSummary(ok: CalcOk[]) {
  const box = $("summary");
  if (!ok.length) {
    box.innerHTML = `<div class="kpi"><div class="lab">比較するモデルを選んでください</div><div class="sub">左の「比較するモデル」から追加できます。</div></div>`;
    return;
  }
  const lo = ok[0], hi = ok[ok.length - 1];
  const k = (lab: string, x: CalcOk) =>
    `<div class="kpi"><div class="lab">${lab}</div><div class="val">${money(x.usd)}<span class="sub"> /月</span></div><div class="who">${esc(x.m.name)}</div><div class="sub">${esc(where(x.m))} ・ 年 ${money(x.usd * 12)}</div></div>`;
  let html = k("いちばん安い", lo);
  if (ok.length > 1)
    html +=
      k("いちばん高い", hi) +
      `<div class="kpi"><div class="lab">価格差</div><div class="val">${lo.usd > 0 ? sig(hi.usd / lo.usd, 2) + " 倍" : "—"}</div><div class="sub">${ok.length}モデルを比較</div></div>`;
  html += `<div class="premise">前提: ${esc(premiseText())} ・ ${esc(conditionText())}</div>`;
  box.innerHTML = html;
}

function renderTable(ok: CalcOk[], na: CalcResult[]) {
  const t = $<HTMLTableElement>("resTable");
  const max = Math.max(...ok.map((x) => x.usd), 0) || 1;
  $("resTitle").textContent = TABNAME[S.t] + "の月額比較";
  $("resSub").textContent = "安い順。価格の比較であって、性能の順位ではありません";
  t.tHead!.innerHTML =
    S.t === "img"
      ? `<tr><th>#</th><th>モデル</th><th class="num">1枚あたり</th><th class="num">月額</th><th class="num">年額</th><th></th></tr>`
      : `<tr><th>#</th><th>モデル</th><th class="num">入力${unitLabel(S.unit)}</th><th class="num">出力${unitLabel(S.unit)}</th><th class="num">月額</th><th class="num">年額</th><th></th></tr>`;
  const rows = ok.map((x, i) => {
    const name = `<div class="mname">${esc(x.m.name)}</div><div class="mmeta">${esc(x.m.vendor)} ・ ${esc(where(x.m))}</div><div class="flags">${flagHtml(x)}</div>`;
    const w = Math.max((x.usd / max) * 100, x.usd > 0 ? 1.5 : 0);
    const bar = `<td class="barcell"><div class="bar ${x.usd === 0 ? "zero" : ""}" style="width:${w}%"></div></td>`;
    const tail = `<td class="num cost">${money(x.usd)}</td><td class="num">${money(x.usd * 12)}</td>${bar}`;
    if (S.t === "img") return `<tr><td class="rank">${i + 1}</td><td>${name}</td><td class="num">${money(x.perImage ?? 0)}</td>${tail}</tr>`;
    return `<tr><td class="rank">${i + 1}</td><td>${name}</td><td class="num">${unitPrice(x.pin)}</td><td class="num">${unitPrice(x.pout)}</td>${tail}</tr>`;
  });
  t.tBodies[0].innerHTML = rows.join("") || `<tr class="na"><td colspan="7">モデルが選ばれていません。</td></tr>`;
  $("pending").innerHTML = na.length
    ? `計算できなかったモデル:<ul>${na.map((x) => `<li>${esc(x.m.name)}(${esc(where(x.m))}): ${esc((x as { why: string }).why)}</li>`).join("")}</ul>`
    : "";
}

function ruleLabel(r: PriceRule) {
  const parts = [TIER_LABEL[r.tier]];
  if (r.minPromptTokens) parts.push(`プロンプト ${r.minPromptTokens / 1000}K超`);
  if (r.validFrom || r.validTo) parts.push(`${r.validFrom ?? ""}〜${r.validTo ?? ""}`);
  if (r.promo) parts.push("期間限定");
  return parts.join(" ・ ");
}
const srcCell = (m: Model) => {
  const s = m.sources[0] ?? {};
  const label = s.litellm ? "LiteLLM" : "—";
  return s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${label}</a>` : label;
};

function renderUnitTable() {
  const t = $<HTMLTableElement>("unitTable");
  const map = byId();
  const ms = S.sel[S.t].map((id) => map.get(id)).filter((m): m is Model => !!m);
  if (S.t === "img") {
    $("unitSub").textContent = `現在の生成条件。1枚あたり(${S.cur === "JPY" ? "円" : "USD"})。トークン課金モデルは画像出力のみ`;
    t.tHead!.innerHTML = `<tr><th>モデル</th><th>提供環境</th><th>条件</th><th class="num">画像tokens/枚</th><th class="num">単価/枚</th><th class="num">画像出力/1M tokens</th><th>出典</th></tr>`;
    t.tBodies[0].innerHTML = ms
      .map((m) => {
        const result = calcImage(m, { ...S.img, n: 1 });
        const r = m.prices.find((p) => p.tier === "standard" && p.minPromptTokens === 0) ?? m.prices[0];
        const condition = result.na ? result.why : result.imageTokens != null
          ? `${S.img.w ?? 1024}×${S.img.h ?? 1024} / ${S.img.q ?? "medium"}` : S.img.r;
        return `<tr><td class="mname">${esc(m.name)}</td><td class="mmeta">${esc(where(m))}</td><td class="mmeta">${esc(condition)}</td><td class="num">${!result.na && result.imageTokens != null ? int(result.imageTokens) : "—"}</td><td class="num">${!result.na ? money(result.perImage ?? 0) : "—"}</td><td class="num">${r?.imageOutput != null ? money(r.imageOutput) : "—"}</td><td class="mmeta">${srcCell(m)}</td></tr>`;
      })
      .join("");
    return;
  }
  $("unitSub").textContent = `選択中のモデル。${unitLabel(S.unit)}、${S.cur === "JPY" ? "円" : "USD"}。プラン・長文価格ごとにすべて表示`;
  t.tHead!.innerHTML = `<tr><th>モデル</th><th>提供環境</th><th>プラン・条件</th><th class="num">入力</th><th class="num">キャッシュ読取</th><th class="num">キャッシュ書込</th><th class="num">出力</th><th>出典</th></tr>`;
  const rows: string[] = [];
  for (const m of ms) {
    if (!m.prices.length) {
      rows.push(`<tr class="na"><td class="mname">${esc(m.name)}</td><td class="mmeta">${esc(where(m))}</td><td colspan="5">価格未取得</td><td class="mmeta">${srcCell(m)}</td></tr>`);
      continue;
    }
    for (const r of m.prices)
      rows.push(
        `<tr><td class="mname">${esc(m.name)}</td><td class="mmeta">${esc(where(m))}</td><td class="mmeta">${esc(ruleLabel(r))}</td><td class="num">${unitPrice(r.input)}</td><td class="num">${unitPrice(r.cacheRead)}</td><td class="num">${unitPrice(r.cacheWrite)}</td><td class="num">${unitPrice(r.output)}</td><td class="mmeta">${srcCell(m)}</td></tr>`,
      );
  }
  t.tBodies[0].innerHTML = rows.join("") || `<tr class="na"><td colspan="8">モデルが選ばれていません。</td></tr>`;
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
const chartCtx = (): ChartCtx => ({ cm: S.cm, multi: S.cm === "mix" && S.t === "llm", cur: S.cur, fx: fx() });
function renderChart(ok: CalcOk[]) {
  const box = $("chartBox");
  lastChartRows = ok.map((x) => ({ name: x.m.name, sub: `${x.m.vendor} ・ ${where(x.m)}`, plat: where(x.m), total: x.usd, parts: x.parts }));
  $("chartTitle").textContent = `${TABNAME[S.t]}の価格差`;
  $("chartPanel").hidden = !lastChartRows.length;
  if (!lastChartRows.length) {
    box.innerHTML = "";
    return;
  }
  const ctx = chartCtx();
  $("legend").innerHTML = ctx.multi
    ? (["in", "cache", "out"] as const).map((k) => `<span><i style="background:var(--${SERIES[k].c})"></i>${SERIES[k].label}</span>`).join("")
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
    S.img.w = num("imgWidth");
    S.img.h = num("imgHeight");
    S.img.q = $<HTMLSelectElement>("imgQuality").value as State["img"]["q"];
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
    ["imgRes", (v) => {
      S.img.r = v;
      const size = v === "4K" ? [3840, 2160] : v === "2K" ? [2048, 2048] : [1024, 1024];
      [S.img.w, S.img.h] = size;
      syncInputs();
    }],
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
  $("srcNote").innerHTML = `データ: LiteLLM <code>${esc(DATA.sources.litellm.commit.slice(0, 12))}</code>、為替 ${esc(fxs.rate)} 円(${esc(fxs.date)})、生成 ${esc(DATA.generatedAt)}。対象 ${DATA.models.length} モデル。`;
  $("app").hidden = false;
  if (window.innerWidth > 900) ($("modelsBox") as HTMLDetailsElement).open = true;
  bind();
  syncInputs();
  fillFilterOptions();
  renderModelList();
  render();
}

boot();
