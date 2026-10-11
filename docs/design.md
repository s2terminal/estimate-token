# ざっくり生成AI 設計書

## 概要

生成AIの利用料を「1Kトークン/1Mトークン単位・円換算」でざっくり比較できる静的Webアプリを作る。価格データはGitHub Actionsで毎日自動取得し、人手を介さずに新モデルへ追従する。

**MVPに入れるもの**

- 価格データの日次自動更新(LiteLLMの価格JSONとOpenRouter Models APIから取得)
- 対象: OpenAI / Anthropic / Gemini API の直販と、Google Cloud Vertex AI / Amazon Bedrock / Azure 経由の言語モデル。画像生成はソースが枚単価を持つモデルだけ
- 単価表示の1K/1M切替、円換算(為替レートも日次取得、手入力で上書き可)
- 使い方(回数・入出力トークン・キャッシュ率・Batch)からの月額試算と複数モデル比較、価格差グラフ
- 期間限定価格・長文価格・キャッシュ有無の切り替え
- 共有リンク(入力値をURLに入れる)

**後回しにするもの**

- 自動取得できないモデル(Jevなどの意思決定モデル、ソースに載らない新モデル)を手書きで補うデータ層
- 稟議用エクスポート(Markdown・CSV・PNGの書き出し)
- 公式価格ページとの自動照合(スクレイピング)

## 全体アーキテクチャ

サーバーは持たない。GitHub Actionsが毎朝価格を取得してJSONをリポジトリにコミットし、GitHub Pagesが画面とJSONを配信する。

&#91;embedded content: 日次更新と公開の流れ · ソース3つ、5工程、1ゲート\]

ゲートで止まった日は公開データが前日のまま残り、人がPRを確認してマージすると公開される。

## データソース

価格の正はLiteLLMの価格JSON、新モデルの検知と照合はOpenRouter、為替はFrankfurterとする。3つとも認証なしで取得できる(2026-10-11に実取得して確認)。

| ソース | 取得先 | 役割 | 件数(2026-10-11) | 単位・形式 |
| --- | --- | --- | --- | --- |
| [LiteLLM 価格JSON](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) | raw.githubusercontent.com の単一JSON(約2.7MB) | 価格の正。直販とAzure/Bedrock/Vertexの差を持つ | 4,041エントリ(chat 2,898、image\_generation 406) | USD/tokenの数値 |
| [OpenRouter Models API](https://openrouter.ai/api/v1/models) | GET /api/v1/models(約770KB) | 新モデルの検知、LiteLLMとの価格照合、LiteLLM未収録モデルの補完 | 458モデル | USD/tokenの文字列 |
| [Frankfurter](https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY) | GET /v1/latest?base=USD&symbols=JPY | USD/JPYの日次レート(ECB参照レート) | 1値(2026-10-09付 158.25) | JSON |

**LiteLLMで使うフィールド**

- 基本: `input_cost_per_token`、`output_cost_per_token`、`cache_read_input_token_cost`、`cache_creation_input_token_cost`(1時間書込みは `_above_1hr`)
- 料金プラン: 末尾 `_batches` / `_flex` / `_priority` / `_ultrafast`
- 長文価格: `_above_100k_tokens` / `_above_128k_tokens` / `_above_200k_tokens` / `_above_272k_tokens`(プラン接尾辞と組み合わさる)
- 画像: `output_cost_per_image`、解像度別 `output_cost_per_image_1K/2K/4K`、トークン課金の `output_cost_per_image_token`
- 属性: `litellm_provider`、`mode`、`max_input_tokens`、`deprecation_date`、`source`(公式価格ページURL)
- 先頭の `sample_spec` はスキーマ説明用なので除外する

**OpenRouterで使うフィールド**: `id`、`created`、`context_length`、`pricing.prompt / completion / input_cache_read / input_cache_write / image_output`、長文価格の `pricing.overrides[].min_prompt_tokens`、`expiration_date`。

**取れないもの(手書き層で後日対応)**

- 期間限定価格の有効期間。LiteLLMはGemini 3.7 Flashを$0.75/$3.75と現在値だけ持ち、2027-01-01以降の価格はない
- 解像度→画像トークン数の換算(gpt-image-2.5はトークン単価のみ)
- Jevなど、どちらのソースにも載らないモデル

## 正規化スキーマ

1モデルを「モデル系列 × プラットフォーム × リージョン」の1行とし、価格はその下に複数の価格ルールとして持つ。単価はすべて USD/1M tokens(画像は USD/枚)に換算して保存し、1K表示と円換算は画面側で行う。

| フィールド | 内容 | 例 |
| --- | --- | --- |
| `id` | `系列@プラットフォーム:リージョン`。共有リンクに入るので不変 | `gpt-6.1-sol@azure:us` |
| `family` / `name` / `vendor` | モデル系列、表示名、開発元 | `claude-sonnet-5-5` / Claude Sonnet 5.5 / Anthropic |
| `platform` / `region` | `openai` `anthropic` `gemini-api` `vertex-ai` `bedrock` `azure` / `global` `us` `jp` など | `bedrock` / `jp` |
| `category` | `llm` または `image` | `llm` |
| `prices[]` | 価格ルール。`tier`(standard / batch / flex / priority)、`minPromptTokens`(長文価格の開始点、0が通常)、`input` `output` `cacheRead` `cacheWrite` `cacheWrite1h`、画像は `perImage` と `perImageByRes` | `{tier:"batch", minPromptTokens:0, input:1, output:5}` |
| `validFrom` / `validTo` / `promo` | 期間限定価格用。MVPでは常に空(手書き層が入ったら使う) | — |
| `contextWindow` / `deprecationDate` | LiteLLMの `max_input_tokens` / `deprecation_date` | 922000 / 2028-03-11 |
| `firstSeen` / `status` | 初めて取り込んだ日、`active` `deprecated` `price_pending` | 2026-09-29 / `active` |
| `sources[]` | 元のキーと照合結果(LiteLLMキー、OpenRouter id、差異%) | `[{litellm:"azure/us/gpt-6.1-sol"}]` |

ファイル全体は次の形にする。`snapshot`は価格データの取得日で、画面の「価格データ更新日」に表示する。

```json
{
  "schemaVersion": 1,
  "snapshot": "2026-10-11",
  "generatedAt": "2026-10-11T21:17:00Z",
  "sources": {
    "litellm": { "commit": "<sha>", "fetchedAt": "..." },
    "openrouter": { "fetchedAt": "..." },
    "fx": { "pair": "USDJPY", "rate": 158.25, "date": "2026-10-09" }
  },
  "models": [
    {
      "id": "gpt-6.1-sol@openai:global",
      "family": "gpt-6.1-sol", "name": "GPT-6.1 Sol", "vendor": "OpenAI",
      "platform": "openai", "region": "global", "category": "llm",
      "contextWindow": 922000, "firstSeen": "2026-09-29", "status": "active",
      "prices": [
        { "tier": "standard", "minPromptTokens": 0, "input": 2, "cacheRead": 0.1, "cacheWrite": 2.5, "output": 10 },
        { "tier": "standard", "minPromptTokens": 272000, "input": 4, "cacheRead": 0.2, "cacheWrite": 5, "output": 15 },
        { "tier": "batch", "minPromptTokens": 0, "input": 1, "cacheRead": 0.05, "cacheWrite": 1.25, "output": 5 }
      ],
      "sources": [{ "litellm": "gpt-6.1-sol", "openrouter": "openai/gpt-6.1-sol", "diffPct": 0 }]
    }
  ]
}
```

例の単価は2026-10-11時点のLiteLLMの値をそのまま換算したもの。浮動小数点の誤差を消すため、×1,000,000後に有効数字6桁で丸める。

## 日次更新パイプライン

毎朝 06:17 JST に GitHub Actions が価格を取得し、品質ゲートを通れば main に直接コミットして GitHub Pages に公開する。ゲートに引っかかった日はPRを作って止め、公開中のデータは前日のままにする。

1. **取得(fetch)**: LiteLLMの価格JSONの最新コミットSHAをGitHub APIで調べ、そのSHAのファイルを取得する(再現できるように)。OpenRouterとFrankfurterも取得し、生データを `raw/` に置く(コミットはしない、Actionsのartifactに14日保存)。
2. **選別(select)**: `config/catalog.yaml` の規則で対象エントリを選ぶ。規則は「`litellm_provider` が許可リストにある」「`mode` が chat / responses / image\_generation」「`deprecation_date` が過ぎていない」。規則に合う新モデルは設定変更なしで自動的に入る。
3. **正規化(normalize)**: キーの形から platform と region を切り出す(下の表)。日付付きの別名(`azure/gpt-6-astra-2026-09-03` など)と、同じ価格の重複エントリは1行にまとめる。単価を×1,000,000して価格ルールにする。
4. **照合(cross-check)**: 直販モデルをOpenRouterの同名モデルと突き合わせ、差異%を `sources[]` に記録する。OpenRouterにだけある主要ベンダーのモデルは `price_pending` で入れ、価格はOpenRouter値を参考表示する。
5. **検証と差分(validate / diff)**: 次節の品質ゲート。前日の `latest.json` との差分をMarkdownにまとめる(新モデル、値下げ、値上げ、廃止)。
6. **公開(publish)**: 中身のハッシュが変わった日だけ `data/latest.json` を上書きして main にコミットする。過去の価格は書き残さない(必要ならgit履歴で追える)。main への push で Pages のデプロイが走る。

| 元のキーの形 | platform | region |
| --- | --- | --- |
| `gpt-6.1-sol`(provider: openai) | openai | global |
| `claude-sonnet-5-5`(provider: anthropic) | anthropic | global |
| `gemini/gemini-3.7-flash` | gemini-api | global |
| `vertex_ai/gemini-3.7-flash`、providerが `vertex_ai-*` の接頭辞なしキー | vertex-ai | global |
| `jp.anthropic.claude-sonnet-5`、`bedrock/us-gov-west-1/...` | bedrock | 接頭辞(`jp` `us` `eu` `global`)、またはパス中のリージョン |
| `azure/gpt-6.1-sol`、`azure/us/gpt-6.1-sol` | azure | global、またはデータゾーン(`us` `eu` `apac`) |

実データでは、同じモデルでも経由で単価が違う。例: `anthropic.claude-sonnet-5` は入力$2.00/1M、`jp.anthropic.claude-sonnet-5` は$2.20/1M。これを別行として扱うために region をIDに含める。

```yaml
# .github/workflows/update-prices.yml(骨格)
on:
  schedule: [{ cron: "17 21 * * *" }]   # 06:17 JST
  workflow_dispatch: {}
permissions: { contents: write, pull-requests: write }
concurrency: { group: update-prices, cancel-in-progress: false }
jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run pipeline        # fetch → select → normalize → cross-check → validate → diff
      - run: npm test                # 計算ロジックと変換の回帰テスト
      - run: node scripts/publish.mjs   # ゲート通過→mainへcommit / 不通過→PR作成
```

## 品質ゲートと異常検知

外部データが壊れても公開中の価格は壊さない。「止める」に該当したらその日は公開せず、差分と理由を書いたPRを作る。人が内容を見てマージすれば公開される。

| チェック | 条件 | 対応 |
| --- | --- | --- |
| 取得失敗 | HTTPエラー、JSONの構文エラー、サイズが前日の50%未満 | 止める |
| スキーマ検証 | 出力が自前のJSON Schemaに合わない、単価が負・NaN | 止める |
| 件数の急減 | 対象モデル数が前日から10%以上減少 | 止める |
| 単価が0になった | 前日は正の入力/出力単価が0または欠落 | 止める |
| 大きな値変わり | 同じ価格ルールで±50%超の変化 | 止める |
| 中くらいの値変わり | ±10〜50% | 公開する。差分をIssueに記録 |
| 照合の不一致 | 直販モデルのLiteLLM値とOpenRouter値の差が20%超 | 公開する。画面に「要確認」を出し、Issueに記録 |
| 新モデル | 規則に合う新キー | 公開する(`firstSeen` を記録)。価格が取れないものは `price_pending` |
| 為替の異常 | USD/JPYが前日比±5%超、または取得失敗 | 為替だけ前日値を使い、価格は公開する |

**通知**: 止めた日はPR、公開した日の値変わり・不一致は1本のIssue(「価格更新ログ」)へのコメントで知らせる。GitHubの通知設定だけで受け取れるので、Slack連携は後回し。ワークフロー自体が3日連続で失敗したときも同じIssueに書く。

しきい値は `config/gates.yaml` に置き、運用しながら調整する。上の数字は初期値の案。

## フロントエンド

プロトタイプの画面をそのまま活かし、アプリに埋め込んだ価格データを「起動時にJSONを読む」形に変える。構成は Vite + TypeScript(フレームワークなし)で、ビルド結果は静的ファイルだけ。

**データの読み込み**

- 常に `data/latest.json` を読む。共有リンクは入力値だけを持ち、価格は開いた時点の最新値で再計算する(リンクを作った日の価格は再現しない。ざっくり見積もり用途なので割り切る)。
- 画面上部に「価格データ更新日」と為替の日付を出す。

**モデルの選び方**: 対象は数百行になるので、初期表示は `config/catalog.yaml` の `featured` に書いた系列(例: 各ベンダーの最上位・バランス・低コスト)だけにし、検索欄と「ベンダー」「プラットフォーム」「リージョン」の絞り込みで追加する。`firstSeen` が14日以内のモデルには「新着」を付ける。`featured` にない新モデルも検索すれば当日から使える。

**計算ロジック**(`src/lib/calc.ts`、画面から独立した純粋関数にしてテストする)

1. 料金プラン(standard / batch / flex / priority)で価格ルールを絞る。そのプランがないモデルは standard で計算し、注記を付ける。
2. 1回あたりの入力トークン数以下で最大の `minPromptTokens` を持つルールを選ぶ(長文価格)。
3. 月額 = 回数 ×(通常入力 × input + キャッシュ読取 × cacheRead + 出力 × output)÷ 1,000,000。cacheRead がないモデルは全量を通常入力として注記。
4. 画像は解像度別単価 → なければ `perImage` → どちらもなければ「計算不可」。
5. 期間限定価格(`validFrom` / `validTo`)の切替はプロトタイプの処理を残すが、MVPのデータには期間情報がないので切替は非表示にする。

**共有リンク**: プロトタイプと同じく、入力値・選んだモデルの `id`をJSON化してbase64urlでURLの `#` 以降に入れる。先頭に版番号(`e2`)を付け、形式を変えても古いリンクを読めるようにする。リンク先の `id` が最新データにないとき(廃止済みなど)は、そのモデルを外して「このモデルは現在のデータにありません」と出す。

**プロトタイプから引き継ぐもの / 外すもの**: 入力フォーム、想定プリセット、比較表、価格差グラフ(3つの見せ方)、単価一覧は引き継ぐ。稟議用のMarkdown/TSV/CSV/PNG出力と、意思決定タブは後回しにするのでMVPでは外す。

## リポジトリ構成とテスト

パイプラインと画面を1つのリポジトリに置き、言語はどちらもTypeScript(Node 22)に統一する。価格ルールの型を両方で共有できるのが理由。

```text
zakkuri-genai/
├─ .github/workflows/
│  ├─ update-prices.yml    # 日次更新(06:17 JST)
│  ├─ deploy-pages.yml     # main への push で Pages に公開
│  └─ ci.yml               # PRで型チェック・テスト
├─ config/
│  ├─ catalog.yaml         # 対象provider・mode、キーの解析規則、表示名、featured
│  ├─ gates.yaml           # 品質ゲートのしきい値
│  └─ overrides.yaml       # 手書き層(後回し。MVPでは空)
├─ pipeline/
│  ├─ fetch.ts  select.ts  normalize.ts  crosscheck.ts
│  ├─ validate.ts  diff.ts  publish.ts
│  └─ schema/prices.schema.json
├─ src/                     # 画面(Vite)
│  ├─ lib/calc.ts  lib/permalink.ts  lib/format.ts
│  ├─ ui/                  # フォーム、比較表、グラフ、単価一覧
│  └─ main.ts
├─ shared/types.ts          # 価格ルールの型(パイプラインと画面で共有)
├─ public/data/
│  └─ latest.json
└─ tests/
   ├─ fixtures/litellm-sample.json  openrouter-sample.json
   ├─ normalize.test.ts  gates.test.ts  calc.test.ts  permalink.test.ts
```

**テストの中身**(Vitest)

- `normalize.test.ts`: 実データから切り出したエントリで、platform/regionの解析、日付付き別名の統合、×1,000,000の丸めを確かめる。例: `gpt-6.1-sol` → standardの入力2 / 出力10、272K超の入力4 / 出力15、batchの入力1 / 出力5
- `gates.test.ts`: 件数急減・単価0化・±50%超の変化で「止める」判定になること
- `calc.test.ts`: プロトタイプで検算した例(月10,000回、入力2,000/出力500、GPT-6.1 Sol → $90)と、長文価格の境界(272,000 と 272,001)
- `permalink.test.ts`: 書き出しと読み戻しで状態が一致すること、旧版(`e1`)のリンクも読めること

フィクスチャは実データから数十エントリを抜いて固定し、外部の変化でテストが落ちないようにする。

## 実装ステップ

データの自動更新を先に完成させ、画面はその後につなぐ。各フェーズは完了条件を満たしてから次に進む。

1. **スキーマと正規化**: `shared/types.ts`、JSON Schema、`select` / `normalize` を書く。
   - 完了条件: 手元で実行して `latest.json` ができ、OpenAI / Anthropic / Gemini API / Vertex AI / Bedrock / Azure の各主要モデルが含まれる。`normalize.test.ts` が通る
2. **照合と品質ゲート**: `crosscheck` / `validate` / `diff` と `gates.yaml`。
   - 完了条件: 壊したフィクスチャ(件数半減、単価0、大幅変更)で「止める」になる。差分Markdownが出る
3. **日次ワークフロー**: `update-prices.yml` と `publish`(mainへcommit / PR作成 / Issueへの記録)。
   - 完了条件: `workflow_dispatch` で手動実行し、通常日はコミット、異常日(テスト用の強制フラグ)はPRになる。7日連続で無人実行できる
4. **画面の移植**: プロトタイプをViteに移し、`latest.json` / スナップショットを読む形にする。検索・絞り込み・新着表示を足す。
   - 完了条件: `calc.test.ts` と `permalink.test.ts` が通る。共有リンクを開くと入力値が復元され、最新の価格で再計算される
5. **公開**: `deploy-pages.yml` で GitHub Pages に公開。
   - 完了条件: 日次更新のコミットで自動的にサイトが更新され、画面の「価格データ更新日」が当日になる

**MVPの後に続けるもの**: 手書き層 `overrides.yaml`(Jevなどの手動モデル、期間限定価格の期間、画像トークンの換算)→ 意思決定タブ → 稟議エクスポートの順。

## 未決事項とリスク

| 項目 | 内容 | 対応案 |
| --- | --- | --- |
| ソース間の価格の食い違い | 同じモデルでもLiteLLM内で値が割れる。例: Gemini 3.1 Flash Imageの1枚単価は `gemini/` が$0.045、Vertex AI側が$0.0672 | platform別の行として両方出す。公式ページとの照合は手書き層の時に検討 |
| 期間限定価格が取れない | LiteLLMもOpenRouterも現在値だけ。期間終了後に両ソースが更新されるまでは古い値が残る | MVPでは「各ソースの現在値」と明記。期間は手書き層で補う |
| LiteLLMの反映遅れ | 新モデルがLiteLLMに載るまでの数日は取れない | OpenRouterだけにある主要ベンダーの新モデルを `price_pending` で先に載せる |
| キーの命名規則の変化 | Bedrockには `bedrock` / `bedrock_converse` / `bedrock_mantle` など複数のprovider値がある | 解析できないキーは捨てず「未分類」として差分レポートに出し、`catalog.yaml` を直す |
| 利用条件 | LiteLLMはリポジトリのMITライセンス。OpenRouter APIの利用規約と再配布の可否は未確認 | 実装前に規約を確認。不可ならOpenRouterは「検知と照合のみ、値は公開しない」に絞る |
| 為替の基準 | FrankfurterはECBの参照レートで、日本の銀行のTTMとはずれる | 「ざっくり」なので許容。画面で手入力で上書きできるようにする |
| ホスティング先 | GitHub Pages(公開リポジトリ前提)でよいか | 社内限定にするなら Cloudflare Pages + Access などを検討 |
