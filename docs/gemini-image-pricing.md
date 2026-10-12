# Geminiの画像生成料金

2026-10-12に[Gemini API公式料金表](https://ai.google.dev/gemini-api/docs/pricing)、[画像生成ガイド](https://ai.google.dev/gemini-api/docs/image-generation)、[Google Cloud公式料金表](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)を確認。

Standardの画像出力料金は、解像度別出力トークン数 × 画像出力単価(USD/1M tokens) ÷ 1,000,000で計算する。
現在の対象プラットフォームはGemini APIとVertex AI Global。単価はプラットフォームごとのLiteLLMデータを使うため、単価の更新も反映する。
公式のトークン数とモデルの対応は `config/image-tokens.json` の `resolution` プロファイルに定義する。

| モデル | 単価 USD/1M画像tokens | 1K tokens / USD | 2K tokens / USD | 4K tokens / USD |
| --- | --- | --- | --- | --- |
| Nano Banana 2.1 | 30 | 1120 / 0.0336 | 1680 / 0.0504 | 3780 / 0.1134 |
| Gemini 3.1 Flash Image | 60 | 1120 / 0.0672 | 1680 / 0.1008 | 2520 / 0.1512 |
| Gemini 3 Pro Image | 120 | 1120 / 0.1344 | 1120 / 0.1344 | 2000 / 0.24 |
| Gemini 3.1 Flash Lite Image | 30 | 1120 / 0.0336 | 非対応 | 非対応 |
| Gemini 2.5 Flash Image (Vertex AI) | 30 | 1290 / 0.0387 | 非対応 | 非対応 |

価格は公式脚注のトークン数と単価から計算した丸め前の値。公式の1枚単価は丸めて表示される場合がある。
入力画像・テキストや思考の出力・検索などは別料金。現在の画像試算はStandardの画像出力に、テキスト入力(プロンプト)を「平均入力 tokens/枚 × 入力単価」で加えたもの。Batchなどの料金プラン切り替えは画像画面には提供しない。

## 共通単価を流用しない

LiteLLMの `output_cost_per_image` は1つの解像度の参考値であることがある。Flash Imageの0.045は0.5K、Nano Banana 2.1の0.0336は1K、Pro Imageの0.134は1K/2Kの値。これらを全解像度へ適用しない。
正規化では `output_cost_per_image_token` を `imageOutput` として共通単価とともに保持する。
`preferTokenVendors` に設定されたGoogleの画像は、共通単価よりトークン換算を優先する。他社の固定単価モデルと、明示的な解像度別1枚単価を持つモデルには既存の計算を使用する。
Geminiは解像度キーで換算し、OpenAI用の幅・高さや画質を使わない。

## 非対応の条件

Flash Lite Imageは公式仕様で1Kのみ対応。2K・4Kでは試算額を出さず、比較表の「計算できなかったモデル」と単価一覧に対応解像度を表示する。
換算設定がないGoogleのトークン課金モデル、画像トークン単価を取得できなかった対応モデルにも共通単価を流用せず、理由付きで計算不可にする。これらは価格更新レポートにも表示する。
設定で未対応理由を指定した旧モデルも、共通単価にかかわらず理由を表示する。
Gemini APIのGemini 2.5 Flash Imageは公式料金表で2026-10-02の提供終了が明記されているため、同プラットフォームでは試算対象外とする。Vertex AIの料金表にも掲載がある同系列を一律に停止扱いにせず、1Kの料金計算を提供する。プラットフォーム固有の理由は設定の `系列@platform` を優先する。
同名・別名のモデルが公式の換算仕様を変更した場合の自動検知は未実装。新系列の対応には公式資料の確認と設定追加が必要。

新しい方式は既存の設定・パイプライン・画面で扱えるため、この対応に仕組み上の障害はない。未対応の条件を共通単価で推測して表示することを避ける。
