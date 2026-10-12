# ざっくり生成AI

生成AIの利用料を「1K/1Mトークン単位・円換算」でざっくり比べる静的Webアプリ。設計は [docs/design.md](docs/design.md)、画面の元は [docs/prototype.html](docs/prototype.html)。

OpenAIの画像生成は1K／2K／4Kの解像度と画質から出力トークン数と画像出力料金を概算します。対応モデル・換算の根拠・入力料金などの対象外項目は [docs/image-tokens.md](docs/image-tokens.md) を参照。

Geminiの画像生成は公式の解像度別トークン数と画像出力単価から計算します。Flash Lite Imageの2K／4Kなど、非対応の条件は比較表に理由を表示します。料金と対応範囲は [docs/gemini-image-pricing.md](docs/gemini-image-pricing.md) を参照。

## 構成

| パス | 内容 |
| --- | --- |
| `pipeline/` | 価格データの日次更新(fetch → select → normalize → cross-check → validate → diff) |
| `config/` | 対象の選別規則・表示名・おすすめの系列(`catalog.yaml`)、品質ゲートのしきい値(`gates.yaml`) |
| `config/image-tokens.json` | 画像トークンの換算プロファイル、モデルとの対応、出典・確認日、未対応の理由 |
| `shared/` | パイプラインと画面で共有する価格データの型・画像換算設定 |
| `src/main.ts` | 画面の起動・状態管理・イベント処理 |
| `src/lib/` | 計算・表示形式・モデル検索・共有リンクなどのロジック |
| `src/ui/` | 試算結果の要約・比較表・単価一覧(`results.ts`)とグラフ(`chart.ts`)の描画 |
| `public/data/latest.json` | 公開中の価格データ(パイプラインが更新) |
| `tests/` | Vitest。責務別の配置と追加方針は [tests/README.md](tests/README.md) |

## 開発

```sh
npm ci
npm run dev          # 画面(http://localhost:5173)
npm test             # テスト
npm run typecheck
npm run build        # dist/ に静的ファイルを出力
npm run check        # CIと同じ検証: テスト → 型チェック → ビルド
npm run pipeline     # 価格を取得して public/data/latest.json を更新
npm run pipeline -- --offline     # raw/ に置いた前回の生データで再実行
npm run pipeline -- --force-stop  # 品質ゲートで止めた扱いにする(動作確認用)
```

パイプラインは `out/report.md`(差分と判定)と `out/gate.json` も出力します。
`build` は型チェックを含み、`check` とCIでも型チェックは1回だけ実行します。

公式ドキュメントの料金計算例を固定期待値として検証するテストは `tests/reference/official-pricing-examples.test.ts`。出典・採用範囲・資料の丸め値の扱いは [docs/official-pricing-examples.md](docs/official-pricing-examples.md) を参照。

## おすすめの初期選択

`config/catalog.yaml` の `recommendations` で用途ごとの系列を定義し、各系列から1件を選びます。高性能・バランス・低コストや画像モデルの系列は分け、同じ系列の旧世代は初期選択から外します。Gemini Pro はプレビュー版も候補に含めます。

同一モデルの提供先違いは直販APIを優先し、直販がなければ global、提供先の固定順で1件を選びます。Gemini APIとVertex AI、OpenAI APIとAzureなどを重複選択しません。地域別料金や提供先の違いを比較したい場合は検索・絞り込みから追加できます。共有リンクの選択内容はそのまま復元します。

リリース日時はLiteLLMの明示的な `release_date` が取得できた場合だけ `releaseDate` に保持します。日時が判明している候補同士は新しい日時を優先し、同日時なら数値バージョンで選びます。日時不明の候補はバージョンで最新を選び、日時がある候補の勝者ともバージョンで比較します。これにより、日時が不明な新世代が古い既知日時のモデルに固定されることを防ぎます。2026-10-12の取得元にはリリース日時がないため、現データではバージョンを使用します。`firstSeen`、更新日、モデルIDの日付部分を発売日とみなすことはありません。

標準料金がないモデル、廃止済みモデル、画像の料金換算に未対応のモデルはおすすめから除きます。新しい画像モデルは換算仕様への対応後に候補になります。全モデルの価格データや手動選択は維持します。

## OpenRouter の扱い

OpenRouter の利用規約はサイト・API上の情報のコピーや譲渡を禁じているため、OpenRouter は新モデルの検知と価格の照合にだけ使います。OpenRouter の価格・id・差異%は、公開データ・Issue/PRのレポート・Actionsのartifact・テストのフィクスチャのいずれにも含めません(`tests/fixtures/openrouter-sample.json` は架空のデータ)。

## GitHub Actions

- `update-prices.yml`: 毎朝 06:17 JST。ゲート通過なら main へコミット、止めた日はPRを作成、値変わり・照合の不一致はIssue「価格更新ログ」にコメント
- `deploy-pages.yml`: main への push と日次更新の完了で GitHub Pages に公開
- `ci.yml`: PRで型チェック・テスト・ビルド

### 初回の設定

1. Settings → Pages → Build and deployment の Source を **GitHub Actions** にする
2. Settings → Actions → General → Workflow permissions で **Read and write** と **Allow GitHub Actions to create and approve pull requests** を有効にする

