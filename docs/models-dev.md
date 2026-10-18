# models.dev の採用範囲

価格と仕様を LiteLLM、models.dev の順で統合します。OpenRouter は従来どおり検知・照合専用で、価格・ID・差異率を公開データに転記しません。

## 取得と再実行

`https://models.dev/catalog.json` を1回取得し、共通モデル情報と提供先の価格を同じスナップショットとして扱います。`raw/models-dev.catalog.json` と `raw/models-dev.meta.json` に URL、取得日時、SHA-256、UTF-8 bytes、ETag、共通モデル数と対象 provider 別件数を保存します。APIスナップショットは内容ハッシュで識別し、GitHubのHEADをAPIの版とみなしません。

HTTPエラー、30秒のタイムアウト、不正なルート・レコード、負・非有限の料金、重複した長文境界、50MiB超の応答を拒否します。保存済みの正常rawは検証通過後にだけ置き換えます。取得サイズ・provider別件数の急減は `config/gates.yaml` の比率で止めます。

ソース障害時は保存済み正常rawを元の取得日時と `stale` 付きで使います。rawもない場合、前回公開済みデータがあればモデル・価格・採用元全体を維持します。利用していない新しいLiteLLMの取得情報を古い料金に付けないため、この場合は両価格ソースを前回値として記録します。初回でLiteLLMも前回値もなければ更新を失敗させます。未導入のmodels.devだけが取得できない初回は、LiteLLMで従来どおり実行できます。

日次Actionsは価格ソースの正常rawをcacheへ保存し、rawとメタ情報をartifactにも含めます。OpenRouterのrawはcache・artifactへ含めません。ソース障害をモデル廃止や無料とみなしません。

```sh
npm run pipeline -- --offline
# 公開中のファイルを変更せず、任意のスナップショットを検証する
npm run pipeline -- --offline --raw=/tmp/raw --data=/tmp/latest.json --out=/tmp/report
```

## 設定ファイル

[`config/models-dev-policy.yaml`](../config/models-dev-policy.yaml) は、models.dev由来のデータを採用する条件を定義します。価格の異なる提供先やモデルを誤って統合しないため、確認できた範囲を明示します。

| 項目 | 役割 |
| --- | --- |
| `offers` | 価格補完を許可するprovider/model IDと、入力長の境界・確認日・根拠資料を登録します。`allowNew: true` なら新規追加も許可します。汎用cache writeを採用する場合は確認済みTTLも指定します |
| `recommendationPreviews` | おすすめに含めてよい確認済みpreviewの既存モデルIDを登録します。価格補完・新規追加の許可には使いません |
| `metadata` | 既存モデルIDとmodels.devの共通モデルIDの確認済み対応を登録します。現在は空です。価格の照合には使いません |

`offers` に未登録の提供条件は、価格補完・新規追加を保留して候補としてレポートします。リリース日などのメタデータは、元IDやcanonical参照を確認できれば `offers` への登録がなくても補完できます。

更新するときは提供先・snapshot・地域・サービスティア・入力長境界・キャッシュTTLを確認し、確認日と根拠資料を記録します。登録済みでも料金の競合や未確認条件があれば採用を保留します。更新後は `npm run check` とパイプラインの差分レポートを確認してください。

## 照合と価格採用

対象は OpenAI / Anthropic / Google と、Vertex二系統、Bedrock、Azure二系統です。元のprovider/model IDを残し、LiteLLMの代表キーへ完全一致した提供先だけを照合します。日付付きsnapshot、地域接頭辞、Vertexの `@default` を照合時に削除しません。共通 `canonical_model_id` はメタデータとおすすめの重複除去に使い、価格の結合には使いません。

- LiteLLMのUSD/tokenだけを100万倍します。models.devはUSD/1Mのまま使います。
- 両方にある数値は絶対差 `1e-8` または相対差 `1e-5` 以下を一致とします。それ以外は20%未満の差も値・元ID・条件付きで全件レポートし、既存値を維持します。
- 提供条件と公開APIでの利用を確認した直販モデルを `config/models-dev-policy.yaml` の `offers` に出典・確認日・正確な入力長境界付きで登録します。この許可リストだけが不足料金の補完や新規追加を行えます。初期対象はGPT-6.1 Sol、Claude Sonnet 5.5、Gemini 2.5 Flashです。
- 既存の標準料金に競合や未確認の長文境界があれば補完しません。確認できたルール集合内で不足項目・ルールを補完します。batch/flex/priorityと1時間cache writeは保持します。汎用cache writeを5分料金として採用するには別途TTLの明示確認が必要です。
- `cost.tiers[].tier.size` を優先します。`context_over_200k` は272K等の互換出力でもあるため、単独では採用しません。実設定が未確認のexperimental modeも採用せずレポートします。
- Cloudの地域・サービス条件が未確認の場合は自動補完しません。同じアプリIDに対応するAzure/Vertexの複数providerで料金が違う場合は競合を記録して補完・新規追加を保留します。
- 出力がtext単独ではないモデルの汎用costをテキスト価格へ変換しません。画像単価は引き続きLiteLLMと画像換算設定を使用します。他提供先の価格や、画像価格の欠損を無料として転用しません。

価格ルールの `provenance` は項目ごとの採用元、`comparedSources` は同一条件で一致を確認した照合元です。元ID、URL、補完時の確認日・参照資料を含みます。裁定した価格のoverrideは今回使用しません。`config/overrides.yaml` は引き続き未使用です。

## 仕様とおすすめ

`contextWindow` は既存の入力上限という意味を保ちます。`inputLimit`、`totalContext`、`outputLimit` を別々に保持し、提供先の `limit.input` 欠損を総contextで埋めません。機能・モダリティ・公開状態は完全一致した提供先から補完し、元providerのstatusも保存します。

リリース日は共通モデル情報を優先し、なければ完全一致した提供先同士で一致する明示日付を使います。年月は年月のまま保存し、`releaseDateSource.precision` と出典を保持します。更新日、知識期限、firstSeen、モデルIDから推測しません。

おすすめは統合後に再計算し、canonicalで提供先の重複を避けます。月精度の区間が重なる場合はバージョンで比較します。未来日・alpha・deprecated・未確認previewは自動選択しません。既存のGemini Pro Previewは確認済みリストで維持します。手動選択と共有リンクの既存IDは変更しません。

既存スキーマの追加フィールドとして導入し、schemaVersionは1を維持します。旧JSONも読み込めます。UIの単価一覧は価格採用元とリリース日の出典を分けて表示します。差分は全ティアの価格と採用元変更を含みます。取得日時や未採用データだけの変化では価格コミットを作りません。

## 固定フィクスチャとライセンス

`tests/fixtures/models-dev.catalog.json` は2026-10-18にライブAPIから取得した応答のうち、受け入れテストに必要な原レコードを値を変えずに抽出したものです。元応答のURL・取得日時・SHA-256・bytes・ETag・件数と抽出ファイル自体のハッシュを `models-dev.meta.json` に保存します。合成データを使う境界条件テストは `tests/support/models-dev.ts` と区別します。

更新が必要なときだけ `node scripts/capture-models-dev.mjs` を実行します。ライブAPIへ接続できる環境が必要です。通常CIは固定fixtureでテストし、APIの可用性に依存しません。更新後は内容の差と `npm run check` を確認してください。

models.devはMIT Licenseです。著作権表示と全文を `public/licenses/models-dev.txt` に同梱し、サイトの出典欄からリンクします。
