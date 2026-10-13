# 価格更新ログの確認 (2026-10-13)

対象: [Issue #3](https://github.com/s2terminal/estimate-token/issues/3) の全3コメント。

## 修正した項目

- Azure の `global-standard/` を解析する。通常の `global` とデプロイ種別を分け、料金を混ぜない。同じ種別の日付付き別名は従来どおり統合する。
- Bedrock の `invoke/` は呼び出し経路として取り除き、既存の同一モデルに別名として統合する。
- Gemini API の接頭辞なしキーを解析し、接頭辞付きキーと統合する。
- `max-x-max/` の画像サイズ・ステップ別料金と `openai/container` のセッション料金は対象外として選別する。
- 日次更新は起動時点の `main` を checkout する。失敗した [run 38176405078](https://github.com/s2terminal/estimate-token/actions/runs/38176405078) は取得・品質ゲート・テストが成功し、古いコミットからの push が `fetch first` で拒否されていた。その後の更新は成功済み。実行途中に main が進んだ場合の競合は引き続き停止するため、最新 main から再実行する。

## 単価変更が不要な項目

`gpt-5.6-sol@openai:global` の標準料金は [OpenAI 公式料金表](https://developers.openai.com/api/docs/pricing) と一致する。100万トークン当たり、通常文脈は入力 $4、出力 $20、キャッシュ読み取り $0.40、書き込み $5。272K 超ではそれぞれ $8、$30、$0.80、$10。

[モデルページ](https://developers.openai.com/api/docs/models/gpt-5.6-sol) ではプロモーション価格を少なくとも2026-11-21まで提供するとしている。照合先との不一致だけを根拠に上書きせず、`needsReview` を維持する。終了日以後の料金は再確認が必要。OpenRouter の値・ID・差異率は記録しない。

## 保留する項目

- LiteLLM 未収録の4候補は、既存方針どおり収録待ち。名前だけから価格を補完しない。
- 画像換算の7行は未対応判定を維持する。旧 Gemini 2モデルは [既存の確認記録](gemini-image-pricing.md) に従う。
- GPT Image 1 Mini は [公式ガイド](https://developers.openai.com/api/docs/guides/image-generation) の旧モデル用トークン表とMiniの1枚単価が整合せず、専用換算を確認できない。`chatgpt-image-latest` も固定モデルへの対応を確認できないため推測しない。
- MAI Image 2.6 / Flash は [Microsoft のガイド](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image) にサイズ制限があるが、解像度から出力トークン数への換算根拠は確認できなかった。画像換算対応は保留する。

## 検証

LiteLLM コミット `a86ad9ebf82a8ba8f58fa765f61bf38ee231d4f5` の全データで選別・正規化を再実行。未解析は12件から0件、モデル数は847件から849件。追加は `gpt-4o@azure:global-standard` と `gpt-4o-mini@azure:global-standard`。既存モデルの価格ルール変更は0件。

Issue のキーと比較用の既存キーを `tests/fixtures/price-log-sample.json` に必要な項目だけ保存し、選別・重複統合・デプロイ種別の料金分離を回帰テストで検証する。公開データの更新は通常の日次パイプラインで行う。
