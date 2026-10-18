import { resolveImageTokenProfile } from "../../shared/image-token-config.ts";
import type { Model, PriceData, PriceRule } from "../../shared/types.ts";
import { type CalcOk, type CalcNa, type CalcResult, TIER_LABEL, calcImage } from "../lib/calc.ts";
import { esc, int, money as fmtMoney, sig, unitLabel, unitPrice as fmtUnit } from "../lib/format.ts";
import { modelFlags, where } from "../lib/models.ts";
import { type State, TAB_LABEL } from "../lib/state.ts";
import { $ } from "./dom.ts";
import { sourceCell } from "../lib/sources.ts";

/** 試算結果の要約・比較表・単価一覧。イベント処理やアプリの状態管理は持たない。 */
export function renderResults(data: PriceData, state: State, ok: CalcOk[], na: CalcNa[]) {
  const fx = () => state.fx ?? data.sources.fx.rate;
  const money = (usd: number) => fmtMoney(usd, state.cur, fx());
  const unitPrice = (per1M?: number) => fmtUnit(per1M, state.unit, state.cur, fx());
  const byId = () => new Map(data.models.map((m) => [m.id, m]));

  function premiseText() {
    if (state.t === "llm") {
      const L = state.llm;
      return `月 ${int(L.n)} 回 × 入力 ${int(L.i)} / 出力 ${int(L.o)} tokens/回 ・ ${TIER_LABEL[L.tier]} ・ キャッシュ ${L.c ? L.h + "%" : "なし"}`;
    }
    return `月 ${int(state.img.n)} 枚 × 入力 ${int(state.img.i ?? 0)} tokens/枚 ・ 解像度 ${state.img.r} ・ OpenAI画質 ${state.img.q ?? "medium"}`;
  }
  const conditionText = () => `為替 1 USD = ${fx()} 円 ・ 価格データ ${data.snapshot} ・ 税抜`;
  const allFlags = (x: CalcResult) => [...modelFlags(x.m, data), ...x.flags];
  const flagHtml = (x: CalcResult) => allFlags(x).map((f) => `<span class="flag ${f.k}">${esc(f.t)}</span>`).join("");

  function renderSummary(ok: CalcOk[]) {
    const box = $("summary");
    if (!ok.length) {
      box.innerHTML = state.sel[state.t].length
        ? `<div class="kpi"><div class="lab">この条件では試算できません</div><div class="sub">非対応のモデル・解像度の理由を比較表に表示しています。</div></div>`
        : `<div class="kpi"><div class="lab">比較するモデルを選んでください</div><div class="sub">左の「比較するモデル」から追加できます。</div></div>`;
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

  function renderTable(ok: CalcOk[], na: CalcNa[]) {
    const t = $<HTMLTableElement>("resTable");
    const max = Math.max(...ok.map((x) => x.usd), 0) || 1;
    $("resTitle").textContent = TAB_LABEL[state.t] + "の月額比較";
    $("resSub").textContent = "安い順。価格の比較であって、性能の順位ではありません";
    t.tHead!.innerHTML =
      state.t === "img"
        ? `<tr><th>#</th><th>モデル</th><th class="num">1枚あたり</th><th class="num">月額</th><th class="num">年額</th><th></th></tr>`
        : `<tr><th>#</th><th>モデル</th><th class="num">入力${unitLabel(state.unit)}</th><th class="num">出力${unitLabel(state.unit)}</th><th class="num">月額</th><th class="num">年額</th><th></th></tr>`;
    const rows = ok.map((x, i) => {
      const name = `<div class="mname">${esc(x.m.name)}</div><div class="mmeta">${esc(x.m.vendor)} ・ ${esc(where(x.m))}</div><div class="flags">${flagHtml(x)}</div>`;
      const w = Math.max((x.usd / max) * 100, x.usd > 0 ? 1.5 : 0);
      const bar = `<td class="barcell"><div class="bar ${x.usd === 0 ? "zero" : ""}" style="width:${w}%"></div></td>`;
      const tail = `<td class="num cost">${money(x.usd)}</td><td class="num">${money(x.usd * 12)}</td>${bar}`;
      if (state.t === "img") return `<tr><td class="rank">${i + 1}</td><td>${name}</td><td class="num">${money(x.perImage ?? 0)}</td>${tail}</tr>`;
      return `<tr><td class="rank">${i + 1}</td><td>${name}</td><td class="num">${unitPrice(x.pin)}</td><td class="num">${unitPrice(x.pout)}</td>${tail}</tr>`;
    });
    t.tBodies[0].innerHTML = rows.join("") || `<tr class="na"><td colspan="${state.t === "img" ? 6 : 7}">${na.length ? "この条件では試算できません。" : "モデルが選ばれていません。"}</td></tr>`;
    $("pending").innerHTML = na.length
      ? `計算できなかったモデル:<ul>${na.map((x) => `<li>${esc(x.m.name)}(${esc(where(x.m))}): ${esc(x.why)}</li>`).join("")}</ul>`
      : "";
  }

  function ruleLabel(r: PriceRule) {
    const parts = [TIER_LABEL[r.tier]];
    if (r.minPromptTokens) parts.push(`プロンプト ${r.minPromptTokens / 1000}K超`);
    if (r.validFrom || r.validTo) parts.push(`${r.validFrom ?? ""}〜${r.validTo ?? ""}`);
    if (r.promo) parts.push("期間限定");
    return parts.join(" ・ ");
  }
  const srcCell = sourceCell;

  function renderUnitTable() {
    const t = $<HTMLTableElement>("unitTable");
    const map = byId();
    const ms = state.sel[state.t].map((id) => map.get(id)).filter((m): m is Model => !!m);
    if (state.t === "img") {
      $("unitSub").textContent = `現在の生成条件。1枚あたり(${state.cur === "JPY" ? "円" : "USD"})は入力込み。入力は${unitLabel(state.unit)}。非対応のモデル・解像度は理由を表示`;
      t.tHead!.innerHTML = `<tr><th>モデル</th><th>提供環境</th><th>条件</th><th class="num">画像tokens/枚</th><th class="num">単価/枚</th><th class="num">入力${unitLabel(state.unit)}</th><th class="num">画像出力/1M tokens</th><th>出典</th></tr>`;
      t.tBodies[0].innerHTML = ms
        .map((m) => {
          const result = calcImage(m, { ...state.img, n: 1 });
          const r = m.prices.find((p) => p.tier === "standard" && p.minPromptTokens === 0) ?? m.prices[0];
          const condition = result.na ? result.why : result.imageTokens != null
            ? `${state.img.r}${resolveImageTokenProfile(m.family).profile?.method === "resolution" ? "" : ` / ${state.img.q ?? "medium"}`}` : state.img.r;
          return `<tr><td class="mname">${esc(m.name)}</td><td class="mmeta">${esc(where(m))}</td><td class="mmeta">${esc(condition)}</td><td class="num">${!result.na && result.imageTokens != null ? int(result.imageTokens) : "—"}</td><td class="num">${!result.na ? money(result.perImage ?? 0) : "—"}</td><td class="num">${unitPrice(r?.input)}</td><td class="num">${r?.imageOutput != null ? money(r.imageOutput) : "—"}</td><td class="mmeta">${srcCell(m)}</td></tr>`;
        })
        .join("") || `<tr class="na"><td colspan="8">モデルが選ばれていません。</td></tr>`;
      return;
    }
    $("unitSub").textContent = `選択中のモデル。${unitLabel(state.unit)}、${state.cur === "JPY" ? "円" : "USD"}。プラン・長文価格ごとにすべて表示`;
    t.tHead!.innerHTML = `<tr><th>モデル</th><th>提供環境</th><th>プラン・条件</th><th class="num">入力</th><th class="num">キャッシュ読取</th><th class="num">キャッシュ書込</th><th class="num">出力</th><th>出典</th></tr>`;
    const rows: string[] = [];
    for (const m of ms) {
      if (!m.prices.length) {
        rows.push(`<tr class="na"><td class="mname">${esc(m.name)}</td><td class="mmeta">${esc(where(m))}</td><td colspan="5">価格未取得</td><td class="mmeta">${srcCell(m)}</td></tr>`);
        continue;
      }
      for (const r of m.prices)
        rows.push(
          `<tr><td class="mname">${esc(m.name)}</td><td class="mmeta">${esc(where(m))}</td><td class="mmeta">${esc(ruleLabel(r))}</td><td class="num">${unitPrice(r.input)}</td><td class="num">${unitPrice(r.cacheRead)}</td><td class="num">${unitPrice(r.cacheWrite)}</td><td class="num">${unitPrice(r.output)}</td><td class="mmeta">${srcCell(m, r)}</td></tr>`,
        );
    }
    t.tBodies[0].innerHTML = rows.join("") || `<tr class="na"><td colspan="8">モデルが選ばれていません。</td></tr>`;
  }

  renderSummary(ok);
  renderTable(ok, na);
  renderUnitTable();
}
