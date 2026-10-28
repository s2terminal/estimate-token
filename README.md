# ざっくり生成AI

生成AIの利用料を「1K/1Mトークン単位・円換算」でざっくり比べる静的Webアプリ。設計は [docs/design.md](docs/design.md)、画面の元は [docs/prototype.html](docs/prototype.html)。

OpenAIの画像生成は1K／2K／4Kの解像度と画質から出力トークン数と画像出力料金を概算します。対応モデル・換算の根拠・入力料金などの対象外項目は [docs/image-tokens.md](docs/image-tokens.md) を参照。

Geminiの画像生成は公式の解像度別トークン数と画像出力単価から計算します。Flash Lite Imageの2K／4Kなど、非対応の条件は比較表に理由を表示します。料金と対応範囲は [docs/gemini-image-pricing.md](docs/gemini-image-pricing.md) を参照。

「価格の条件と表示」で期間限定の割引価格を加味するか選べます。初期値と設定のない旧リンクは「加味しない」で、選択は共有リンクにも保存されます。言語モデル・画像生成の両方に適用し、期間は価格データ更新日で判定します。加味しない場合は通常価格(判明している割引終了後の価格を含む)を使い、通常価格が未取得なら試算不可とします。切り替えは `promo`・`validFrom`・`validTo` の情報がある価格が対象です。CC BY 4.0のGemini API公式料金表から5モデルの割引・通常価格を取り込みます。対象外のモデル・提供環境は識別できない割引を除外できず、取得値を使います。出典、ライセンス、対象範囲、更新の中断条件は [docs/promotions.md](docs/promotions.md) を参照。

## 構成

| パス | 内容 |
| --- | --- |
| `pipeline/` | 価格データの日次更新(fetch → select → normalize → merge → recommend → cross-check → validate → diff) |
| `config/` | 対象の選別規則・表示名・おすすめの系列(`catalog.yaml`)、品質ゲートのしきい値(`gates.yaml`) |
| `config/models-dev-policy.yaml` | models.devの価格補完・新規追加・previewのおすすめ採用・共通モデルID対応の条件。項目の説明は[設定ファイル](docs/models-dev.md#設定ファイル)を参照 |
| `config/image-tokens.json` | 画像トークンの換算プロファイル、モデルとの対応、出典・確認日、未対応の理由 |
| `shared/` | パイプラインと画面で共有する価格データの型・画像換算設定 |
| `src/main.ts` | 画面の起動・状態管理・イベント処理 |
| `src/lib/` | 計算・表示形式・モデル検索・共有リンクなどのロジック |
| `src/ui/` | 試算結果の要約・比較表・単価一覧(`results.ts`)とグラフ(`chart.ts`)の描画 |
| `public/data/latest.json` | 公開中の価格データ(パイプラインが更新) |
| `tests/` | Vitest。責務別の配置と追加方針は [tests/README.md](tests/README.md) |

## 開発

Node.js は最新の22系を推奨します（`.node-version`）。[eMudhraの中間CA秘密鍵漏えい](https://emudhra.we-have-a-problem.com/)への対策を含む22.23.4以上、または24.22.1以上の24系・26.12.1以上の26系が必要です。`.npmrc` の `engine-strict` で未対応のNode.jsによる依存インストールを止めます。

```sh
npm ci
npm run dev          # 画面(http://localhost:5173)
npm test             # テスト
npm run typecheck
npm run build        # dist/ に静的ファイルを出力
npm run check        # CIと同じ検証: テスト → 型チェック → ビルド
npm run audit        # npm依存を監査（moderate以上で失敗、ネットワーク接続が必要）
npm run pipeline     # 価格を取得して public/data/latest.json を更新
npm run pipeline -- --offline     # raw/ に置いた前回の生データで再実行
npm run pipeline -- --force-stop  # 品質ゲートで止めた扱いにする(動作確認用)
```

パイプラインは `out/report.md`(差分と判定。Issue/PR 用に GitHub の文字数上限内へ切り詰め)、`out/report-full.md`(全文)と `out/gate.json` も出力します。
`build` は型チェックを含み、`check` とCIでも型チェックは1回だけ実行します。

CI・公開・日次更新は `.node-version` を参照し、毎回最新の22系を確認します。`npm run audit` はCIで実行します。公開・日次更新は `npm ci --no-audit` を使い、監査での検出や監査APIの障害で公開処理が止まることを避けます。DependabotがnpmとGitHub Actionsの更新PRを毎週作成します。Node.jsの新たなセキュリティ修正が出た際は `package.json` の最低バージョンも見直してください。npm監査はNode.js本体やOSの証明書ストアを検査しないため、それぞれの更新も必要です。

公式ドキュメントの料金計算例を固定期待値として検証するテストは `tests/reference/official-pricing-examples.test.ts`。出典・採用範囲・資料の丸め値の扱いは [docs/official-pricing-examples.md](docs/official-pricing-examples.md) を参照。

## おすすめの初期選択

`config/catalog.yaml` の `recommendations` で用途ごとの系列を定義し、各系列から1件を選びます。高性能・バランス・低コストや画像モデルの系列は分け、同じ系列の旧世代は初期選択から外します。Gemini Pro はプレビュー版も候補に含めます。

同一モデルの提供先違いは直販APIを優先し、直販がなければ global、提供先の固定順で1件を選びます。Gemini APIとVertex AI、OpenAI APIとAzureなどを重複選択しません。地域別料金や提供先の違いを比較したい場合は検索・絞り込みから追加できます。共有リンクの選択内容はそのまま復元します。

リリース日時はLiteLLMとmodels.devの明示値から補完し、models.devの共通モデル情報を優先します。年月は精度を保ったまま比較し、日付の区間が重なる場合や日付不明の後継とは数値バージョンで比較します。価格とリリース日の採用元は単価一覧で確認できます。`firstSeen`、更新日、モデルIDの日付部分を発売日とみなすことはありません。未来日・alpha・deprecated・未確認previewは自動選択しません。

models.devの取得・価格採用・Cloudの競合・障害時の前回値維持・固定fixtureの詳細は [docs/models-dev.md](docs/models-dev.md) を参照してください。

標準料金がないモデル、廃止済みモデル、画像の料金換算に未対応のモデルはおすすめから除きます。新しい画像モデルは換算仕様への対応後に候補になります。全モデルの価格データや手動選択は維持します。

## OpenRouter の扱い

OpenRouter の利用規約はサイト・API上の情報のコピーや譲渡を禁じているため、OpenRouter は新モデルの検知と価格の照合にだけ使います。OpenRouter の価格・id・差異%は、公開データ・Issue/PRのレポート・Actionsのartifact・テストのフィクスチャのいずれにも含めません(`tests/fixtures/openrouter-sample.json` は架空のデータ)。

## GitHub Actions

- `update-prices.yml`: 毎朝 06:17 JST。ゲート通過なら main へコミット、止めた日はPRを作成、値変わり・照合の不一致はIssue「価格更新ログ」にコメント。Slack設定時は実行結果も通知
- `deploy-pages.yml`: main への push と日次更新の完了で GitHub Pages に公開
- `ci.yml`: PRで型チェック・テスト・ビルド
- `dependabot-auto-merge.yml`: Dependabot本人のmain向けPRのうち、npmのpatch/minor更新だけGitHub標準のauto-mergeを有効化。npmのメジャー更新とGitHub Actions更新はPRを作成し、手動確認・マージする。別リポジトリからのPRやdraftは対象外

チェック待ち・マージ可否の判定・マージ実行はGitHubに任せます。独自のマージスクリプトは使いません。auto-mergeを有効化する処理ではPRのコードを取得・実行しません。mainの必須チェック `check`（CIの監査・テスト・型チェック・ビルド）が通るとGitHubがマージします。レビューが必須の場合は承認も必要です。

この自動処理は、PR作成者がGitHubの `dependabot[bot]`（Bot）であることを確認してから実行します。通常のPRは従来どおりCIで検証しますが、CIに成功してもこのワークフローがauto-mergeを予約することはありません。必須チェックはマージできる条件であり、全PRを自動マージする設定ではありません。

更新対象と種別は、コミット検証を有効にした `dependabot/fetch-metadata` の出力で判定します。グループPRは最も大きな更新種別を使うため、メジャー更新を含む場合も自動マージしません。メタデータを取得・検証できない場合や更新種別が不明な場合も予約しません。`npm-minor-patch` グループはPRをまとめるための設定で、自動マージの対象制限はワークフロー側で行います。

日次価格更新はDependabot作成のPRではないため、この自動マージ対象に含めません。日次更新・確認用PR作成・公開トリガーは従来の処理を維持します。確認用PRを含む、Dependabot以外が作成したPRは自動予約しません。

### 初回の設定

1. Settings → Pages → Build and deployment の Source を **GitHub Actions** にする
2. Settings → Actions → General → Workflow permissions で **Read and write** と **Allow GitHub Actions to create and approve pull requests** を有効にする

### GitHub標準auto-mergeの設定

このPRをマージする前に、次を設定してください。リポジトリ設定はソースコードだけでは有効になりません。

1. [Fine-grained personal access tokens](https://github.com/settings/personal-access-tokens) でトークンを作る。Resource ownerはこのリポジトリの所有者、Repository accessは **Only select repositories → estimate-token** とし、Repository permissionsの **Contents / Pull requests** をそれぞれ **Read and write** にする。GitHub Actions更新は手動でマージするため、トークンの **Workflows書き込み権限は不要**。すでに付与している場合は外す。
2. [Settings → Secrets and variables → Actions](https://github.com/s2terminal/estimate-token/settings/secrets/actions) に **Repository secret** `AUTOMATION_TOKEN` として登録する。Dependabot PRの `pull_request_target` ワークフローだけで使うため、Dependabot secretsではなくActions secretsへ登録する。日次更新は従来の `GITHUB_TOKEN` を使う。トークンの値はコードに書かない。
3. [Settings → General → Pull Requests](https://github.com/s2terminal/estimate-token/settings) で **Allow auto-merge** と **Allow merge commits** を有効にする。
4. [Settings → Rules → Rulesets](https://github.com/s2terminal/estimate-token/settings/rules) でmainの必須チェックがCIの **check**（提供元GitHub Actions）であることを確認する。このルールは全PRのマージ条件に影響し、日次更新の直接pushにも影響するため、本PRのためにmain全体の保護を一律変更しない。必須チェックを導入・変更する場合は日次更新との両立を先に確認し、両立できない状態ではauto-mergeを有効にしない。auto-merge用に保護を迂回する設定や `--admin` は使わない。
5. 上記の設定後にこのPRをマージする。既存PRでauto-mergeを手動予約する場合もnpmのpatch/minorだけを対象とする。メジャー更新・GitHub Actions更新でauto-mergeが予約済みなら **Disable auto-merge** にする。以後のnpmのpatch/minor更新はワークフローが有効化する。メジャー更新・GitHub Actions更新は差分とCIを確認して手動でマージする。

必須チェックを設定せずにauto-mergeを有効化すると、CI完了を待たずにマージできてしまいます。必ず `check` を必須にしてください。トークンの所有者もこのルールを満たす運用にし、`--admin` によるバイパスは使いません。

`AUTOMATION_TOKEN` は対象のDependabot PRでauto-mergeを有効化するステップだけに渡します。標準の `GITHUB_TOKEN` だけでは、自動マージ後のmainへのpushでPages公開が起動しないためです。トークンは期限切れ前に更新してください。日次ジョブのcheckout・npm・パイプラインにはこのトークンを渡しません。

### Slack通知（Incoming Webhook）

1. Slackアプリで **Incoming Webhooks** を有効にし、通知先チャンネルのWebhook URLを発行する
2. GitHubリポジトリの Settings → Secrets and variables → Actions → **New repository secret** で、`SLACK_WEBHOOK_URL` にそのURLを登録する（URLはリポジトリへコミットしない）

日次実行・手動実行の終了時に、更新成功・変更なし・品質ゲート停止・失敗・キャンセルの結果、対象日（取得できた場合）、Actionsの実行ログへのリンクを通知します。品質ゲート停止時に差分があれば、確認用PRを作成したことも知らせます。注意事項がある場合はレポートの確認を案内します。

Secret未設定なら通知をスキップします。通知の送信に失敗しても価格更新の成否には影響しません。設定後はActionsの **Update prices → Run workflow** で通知を確認できます。

