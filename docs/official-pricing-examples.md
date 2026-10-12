# 公式ドキュメントの料金計算例

確認日: **2026-10-12**。対応するテストは
[`tests/official-pricing-examples.test.ts`](../tests/official-pricing-examples.test.ts)。
単価・入力条件・期待値を固定し、外部APIへの問い合わせや更新される価格スナップショットに依存しない。

## テキスト・トークン課金

| 提供元 | 公式資料・節 | 採用した結果 | 検証範囲 |
| --- | --- | --- | --- |
| OpenAI | [Model Selection Guide / Cost Breakdown](https://developers.openai.com/cookbook/examples/partners/model_selection_guide/model_selection_guide#cost-breakdown) | GPT-4.1: 入力2,000・出力1,500、Batch単価$1/$4で$0.002/$0.006。1,000ページで$8。o4-mini: 入力2,000・出力3,000、$0.55/$2.20で$0.0011/$0.0066。1,000ページで$7.70。両段階の合計$15.70 | `calcLlm` の入出力内訳、Batch選択、回数、合計。OCR段階の入力は画像を含み得るため、文字列からのtokenize例ではなく、資料に記載された入力tokensの課金例として採用 |
| Anthropic | [Pricing / Worked example](https://platform.claude.com/docs/en/about-claude/pricing#worked-example) | Claude Opus 5: 入力50,000×$5/MTok=$0.25、出力15,000×$25/MTok=$0.375。40,000がcache readの場合、通常入力$0.05・cache read $0.02。実行時間$0.08を含む公式合計は$0.705/$0.525 | `calcLlm` はtoken料金の小計$0.625/$0.445と内訳を検証。実行時間課金はアプリ未対応なので、資料の固定費$0.08を別途加えて全体の表示値を照合 |
| Gemini | [Pricing / Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash)、[Understand and count tokens](https://ai.google.dev/gemini-api/docs/tokens) | 通常のテキスト従量課金について、入力・出力の数量と計算済みの金額がそろった例は確認できなかった | 公式計算例のテストとは区別した**料金表由来の補助ケース**を2件追加。入力/出力1M tokensで$0.30/$2.50、cache read 1M tokensで$0.03。合計$2.80はテスト側で設定した期待値であり公式資料の計算結果ではない |

Google Cloudの[Provisioned Throughput / Example cost calculation](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)
にはテキストと音声の混合入力からGSU購入費を算出する例がある。
アプリが扱う従量課金と料金体系が異なるため、`calcLlm` に流用しない。
キャッシュ保存費、キャッシュ書き込み費、検索費、実行時間費はこのアプリのtoken料金とは別に扱う。

## 画像

### OpenAI: 画像生成の出力

出典: [Image generation / GPT Image 2.5 output tokens・Calculating costs](https://developers.openai.com/api/docs/guides/image-generation#calculating-costs)、
[API Pricing / Image tokens](https://developers.openai.com/api/docs/pricing)、
[GPT Image 1.5 / Image tokens](https://developers.openai.com/api/docs/models/gpt-image-1.5)（出力$32/MTok）。

| モデル・条件 | 出力tokens | USD/1M出力tokens | 計算値 USD/枚 | 公式表示 USD/枚 |
| --- | ---: | ---: | ---: | ---: |
| GPT Image 2.5 Sunburst、1024×1024、low | 196 | 30 | 0.00588 | 0.00588 |
| GPT Image 1.5、1024×1024、low | 272 | 32 | 0.008704 | 0.009 |
| GPT Image 1.5、1024×1024、medium | 1056 | 32 | 0.033792 | 0.034 |
| GPT Image 1.5、1024×1024、high | 4160 | 32 | 0.13312 | 0.133 |

`calcImage` を通して出力tokens、1枚料金、合計を検証する。プロンプト、入力画像、部分画像の費用は含まない。
画像入力の[Images and vision](https://developers.openai.com/api/docs/guides/images-vision#calculating-costs)
にもpatch数からbillable tokensを求める例があるが、寸法から入力tokensへの換算はアプリ未実装のため採用しない。

### Gemini: 画像生成の出力と入力

出典: [Gemini API Pricing / 各画像モデルの脚注](https://ai.google.dev/gemini-api/docs/pricing)。

| モデル | 解像度 | 出力tokens | USD/1M出力tokens | 計算値 USD/枚 | 公式表示 USD/枚 |
| --- | --- | ---: | ---: | ---: | ---: |
| Nano Banana 2.1 | 1K / 2K / 4K | 1120 / 1680 / 3780 | 30 | 0.0336 / 0.0504 / 0.1134 | 0.0336 / 0.0504 / 0.113 |
| Gemini 3.1 Flash Image | 1K / 2K / 4K | 1120 / 1680 / 2520 | 60 | 0.0672 / 0.1008 / 0.1512 | 0.067 / 0.101 / 0.151 |
| Gemini 3.1 Flash Lite Image | 1K | 1120 | 30 | 0.0336 | 0.0336 |
| Gemini 3 Pro Image | 1K / 2K / 4K | 1120 / 1120 / 2000 | 120 | 0.1344 / 0.1344 / 0.24 | 0.134 / 0.134 / 0.24 |

10条件を `calcImage` で検証する。Googleの4Kは4096×4096の解像度区分で、OpenAIの横長4K寸法を流用しない。
Gemini 3 Pro Imageの画像入力は560 tokens、単価$2/MTokで$0.00112、資料表示は$0.0011/枚。
この入力料金を `calcLlm` に渡す独立したケースも追加した。
Gemini 2.5 Flash Imageの旧例はGemini APIで提供終了扱いのため、現行モデルの例を優先した。

### Anthropic: 画像入力

出典: [Vision / Resolution and token cost](https://platform.claude.com/docs/en/build-with-claude/vision#resolution-and-token-cost)。

| モデル | 元画像→処理サイズ | 公式visual tokens/枚 | USD/1M入力tokens | 計算値 USD/1,000枚 | 公式表示 USD/1,000枚 |
| --- | --- | ---: | ---: | ---: | ---: |
| Claude Haiku 4.5 | 1000×1000、変更なし | 1296 | 1 | 1.296 | 1.30 |
| Claude Opus 5 | 1000×1000、変更なし | 1296 | 5 | 6.48 | 6.48 |
| Claude Opus 5 | 3840×2160→2576×1449 | 4784 | 5 | 23.92 | 23.92 |

画像生成の料金ではない。公式表の入力tokensを `calcLlm` に渡し、独立した1,000回の料金を検証する。
アプリに寸法からvisual tokensを求める機能はないため、リサイズやpatch分割を検証するテストではない。
テキストのプロンプトと応答の料金は含まない。

## 期待値と実行

公式表示の丸め値を厳密な計算値として扱わない。計算値は `toBeCloseTo(..., 12)` で比較し、
資料の表示精度に丸めた値は独立した固定文字列と比較する。アプリの計算結果自体は丸めない。
資料の式から補った小計や計算値は、上記の表で「計算値」として区別している。

```sh
npm test -- tests/official-pricing-examples.test.ts
npm run typecheck
npm test
npm run build
```

追加ケースは25件（公式資料に基づく23件、Geminiテキストの料金表由来2件）。
モデルの価格・換算仕様が変わった場合は、出典と確認日を更新して期待値の変更理由を残す。
