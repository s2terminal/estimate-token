# テストの配置

| ディレクトリ | 検証対象 |
| --- | --- |
| `app/` | `src/lib/` の計算、画像トークン換算、共有リンク |
| `pipeline/` | データの選別、正規化、照合、おすすめの選定、品質ゲート、更新レポート |
| `shared/` | 画面とパイプラインで共有する画像換算設定 |
| `integration/` | 画像料金計算・未対応判定の連携、公開データとおすすめ初期選択 |
| `reference/` | 公式資料の単価と期待値を固定した料金計算例 |
| `workflows/` | 自動マージの対象判定・CI結果とコミットSHAの確認・公開の起動 |
| `support/` | データ生成・モデル検索・計算成功の確認などの共通処理 |
| `fixtures/` | 固定した取得元データ。OpenRouterのサンプルは架空の値 |

```sh
npm test                          # 全件
npm test -- tests/pipeline        # 責務ごとに実行
npm test -- tests/app/calc.test.ts # ファイル単位で実行
npm run check                     # テスト・型チェック・ビルド
```

追加先は検証対象の責務で選びます。同じ準備・検証を繰り返すケースは `it.each` で入力と期待値を並べます。別の仕様や境界条件は、読みやすい独立したテストとして残します。

`support/fixtures.ts` は正規化済みのデータを必要になった時点で一度だけ作ります。`sampleData()` と `sampleModel(id)` は複製を返すため、単価やフラグを書き換えても他のテストに影響しません。`findModel(models, id)` は渡されたデータ内のモデルを返し、不足時はID付きのエラーにします。

`reference/` は日次の公開データや正規化処理に依存させず、資料の固定期待値を保持します。`integration/` は取得元データの単位・提供先・解像度が計算に反映されることを確認するため、同じ料金例が登場しても検証する経路が異なります。出典と期待値の更新方針は [公式料金例](../docs/official-pricing-examples.md) を参照してください。

models.devのライブAPIから抽出した固定fixtureは `fixtures/models-dev.catalog.json`。元スナップショットと抽出ファイルのハッシュは `models-dev.meta.json` に保存します。境界条件用の合成データは `support/models-dev.ts` と区別します。更新方法と採用条件は [models.devの採用範囲](../docs/models-dev.md) を参照してください。
