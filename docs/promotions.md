# 期間限定価格の取り込み

初期値は「加味しない」。通常価格が将来の適用日付きで公表されている場合も、その価格で試算する。「加味する」は公開データの `snapshot` 日に有効な割引を使う。終了日は含み、翌日は通常価格になる。月額・年額は選択した単価が続くと仮定した換算で、期間をまたいだ請求額予測ではない。

## 採用したデータとライセンス

Google「[Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)」の料金表を、ページ末尾の [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) 表示に基づいて利用する。2026-10-18確認。ページの最終更新表示は2026-10-16。帰属条件は [Google Developers Site Policies](https://developers.google.com/terms/site-policies) も参照。

変更内容は、有料プランの入力・出力・キャッシュ読取単価と日付を抜粋し、USD / 1M tokens の価格ルールへ構造化すること。無料枠、キャッシュ保存料金、ツール料金、招待制Contributorプランは含めない。Googleの名称は出典の帰属に使い、ロゴは使わない。この料金データにはCC BY 4.0が適用され、アプリのコード全体へ同ライセンスを適用するものではない。

出典名・著作者・URL・ライセンスURL・確認日・変更内容を `sources.promotions` に保存する。価格ルールの `source` から参照し、画面の単価一覧と出典欄に表示する。転載・再配布時もこの帰属情報を残す。

| Gemini APIの対象 | プラン | 割引最終日 | 通常価格開始日 |
| --- | --- | --- | --- |
| Gemini 4 Argon | Standard / Batch / Flex / Priority | 2026-11-30 | 2026-12-01 |
| Gemini 3.8 Flash / 3.6 Flash | Standard / Batch / Flex / Priority | 2026-12-31 | 2027-01-01 |
| Robotics ER 2 Preview | Standard / Batch | 2026-12-31 | 2027-01-01 |
| Robotics ER 2 Streaming Preview | Standard | 2026-12-31 | 2027-01-01 |

別サービス・別リージョンへ転用しない。Gemini 3.7 Flashも料金表に記載のない対応を推測して補わない。開始日の記載がない割引に開始日は捏造しない。適用判定は確認した公開スナップショット日で行う。

Google Cloudの料金ページはMarkdown用URLでも取得を試したが、利用可能な応答と再利用ライセンスを確認できず、今回は採用していない。Markdownという形式自体はライセンスの根拠にならない。OpenAI・Anthropicの公式ページからも新たな割引データは取り込まない。対象外は既存のMITライセンスのLiteLLM取得値（確認済みの不足料金はMITのmodels.devで補完）を使い、割引を完全に除外できるとは表示しない。

## 更新処理

`pipeline/fetch.ts` はrobots.txtの `User-agent: *` の規則を取得URLに照らして確認したうえで（RFC 9309に沿い最長一致・同長ならAllow優先。料金表に当てはまらない `Disallow` では止めない）、英語の公式ページへ `Accept: text/markdown, text/html;q=0.9` を指定する。Markdownなら直接、HTMLなら見出し・表をMarkdownへ変換して `pipeline/promotions.ts` で解析する。HTMLにも対応していることは、サーバーがMarkdownを提供するという保証ではない。

対象モデル・プランはレビュー済みの許可リスト。無料列と有料列、単位、割引と通常価格の大小、適用日の連続性、入力・出力・キャッシュの期間一致を検証する。対象追加や未対応の長文条件はレビューが必要。CC表示・リンク、robotsの許可、対象料金表のいずれかを確認できなければ例外で終了し、`latest.json`を書き換えない。既存割引がなくなった際も自動でLiteLLMへ戻さず、公式ページと解析器を見直す。

通常の取り込み順は LiteLLM正規化 → models.dev統合 → OpenRouter照合 → 公式割引の上書き → 品質ゲート。元の未識別価格を同一プランに残さない。期間・割引の有無を品質ゲートのキーに含め、通常価格と割引価格の取り違えを防ぐ。公式情報の確認日も更新判定に含め、他の価格が同じ日でも有効なスナップショット日を進める。

`--offline` は従来のrawファイルに加え `raw/gemini-pricing.txt` と `raw/gemini-pricing.meta.json` (`checkedOn`) を必須とする。ライセンス確認済みの生データとメタ情報はActionsのartifactにも含める。

## 初回反映と検証

初回は閲覧して確認した公式料金表から、[レビュー済みMarkdown抜粋](../config/pricing/gemini-api-reviewed.md)を作成し、同じ解析器・上書き処理で公開JSONに反映した。これは取得したHTTP本文ではなく、出典と変更内容を記載した抜粋。外部HTTP取得はこの作業環境のネットワーク制限により通しで実行できていないため、取得処理はモック応答で検証した。実環境での初回日次更新でHTTP応答形式を確認する必要がある。解析に失敗した場合は既存公開データを維持する。

`tests/pipeline/promotions.test.ts` はMarkdown/HTML、セル内改行、保存料金の除外、欠損・ライセンス不明時の中断、提供先分離、冪等性、終了日境界、試算値、品質ゲートと差分を検証する。
