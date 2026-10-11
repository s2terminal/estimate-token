# ざっくり生成AI

生成AIの利用料を「1K/1Mトークン単位・円換算」でざっくり比べる静的Webアプリ。設計は [docs/design.md](docs/design.md)、画面の元は [docs/prototype.html](docs/prototype.html)。

OpenAIの画像生成は幅・高さ・画質から出力トークン数と画像出力料金を概算します。対応モデル・換算の根拠・入力料金などの対象外項目は [docs/image-tokens.md](docs/image-tokens.md) を参照。

## 構成

| パス | 内容 |
| --- | --- |
| `pipeline/` | 価格データの日次更新(fetch → select → normalize → cross-check → validate → diff) |
| `config/` | 対象の選別規則・表示名・featured(`catalog.yaml`)、品質ゲートのしきい値(`gates.yaml`) |
| `shared/types.ts` | 価格データの型(パイプラインと画面で共有) |
| `src/` | 画面(Vite + TypeScript、フレームワークなし)。計算は `src/lib/calc.ts` |
| `public/data/latest.json` | 公開中の価格データ(パイプラインが更新) |
| `tests/` | Vitest。フィクスチャは実データから切り出して固定 |

## 開発

```sh
npm ci
npm run dev          # 画面(http://localhost:5173)
npm test             # テスト
npm run typecheck
npm run build        # dist/ に静的ファイルを出力
npm run pipeline     # 価格を取得して public/data/latest.json を更新
npm run pipeline -- --offline     # raw/ に置いた前回の生データで再実行
npm run pipeline -- --force-stop  # 品質ゲートで止めた扱いにする(動作確認用)
```

パイプラインは `out/report.md`(差分と判定)と `out/gate.json` も出力します。

## OpenRouter の扱い

OpenRouter の利用規約はサイト・API上の情報のコピーや譲渡を禁じているため、OpenRouter は新モデルの検知と価格の照合にだけ使います。OpenRouter の価格・id・差異%は、公開データ・Issue/PRのレポート・Actionsのartifact・テストのフィクスチャのいずれにも含めません(`tests/fixtures/openrouter-sample.json` は架空のデータ)。

## GitHub Actions

- `update-prices.yml`: 毎朝 06:17 JST。ゲート通過なら main へコミット、止めた日はPRを作成、値変わり・照合の不一致はIssue「価格更新ログ」にコメント
- `deploy-pages.yml`: main への push と日次更新の完了で GitHub Pages に公開
- `ci.yml`: PRで型チェック・テスト・ビルド

### 初回の設定

1. Settings → Pages → Build and deployment の Source を **GitHub Actions** にする
2. Settings → Actions → General → Workflow permissions で **Read and write** と **Allow GitHub Actions to create and approve pull requests** を有効にする
