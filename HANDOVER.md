# 家計ニュース 引き継ぎメモ

> 子育て家庭向け経済ニュース自動配信サイトの運用ドキュメント。
> 最終更新: 2026-05-01

---

## 1. このプロジェクトは何か

毎朝8時に経済ニュースから子育て家庭向けの記事を自動生成し、2つのサイトに配信する自動運用システム。

- **新ブログ（kakei-news）** … Astro + GitHub Pagesで公開
  - URL: <https://0305drystoryyuki.github.io/kakei-news/>
- **既存WordPress（気づけば炒めていた日々）** … やさしい版を予約投稿で配信
  - URL: <https://kizukeba-itametahi.com/category/お勉強/>

各ニュースに対して **詳細版（大人向け）** と **やさしい版（小学生でも分かる）** の2記事を生成し、相互にリンクで行き来できる。

---

## 2. アーキテクチャ全体図

```
[毎朝8:00 JST]
     │
cron-job.org（外部スケジューラー）       ← メイン起動
     │ POST /actions/workflows/.../dispatches
     ▼
GitHub Actions（Daily posts ワークフロー）
     │
     ├── ① npm run generate
     │     ├── RSSから子育て関連ニュース2件選択
     │     ├── Claude API × 4回（詳細版2 + やさしい版2）
     │     └── WordPress REST APIに予約投稿（翌朝9:00 JST公開）
     │
     ├── ② src/content/blog/ にMarkdownコミット & push
     │
     └── ③ Astroビルド & GitHub Pagesデプロイ
              │
              ▼
        新ブログ（kakei-news）即時公開
```

保険として GitHub Actions 内蔵のcron（7:17 / 8:17 / 9:17 JST）も残置している。スクリプト側に **当日の記事ファイルが既にあればスキップ** する重複防止が入っているので、二重生成にはならない。

---

## 3. ファイル構成（重要なものだけ）

```
kakei-news/
├── scripts/
│   └── generate-posts.mjs        # 記事生成のコア。RSS取得→Claude→WP投稿
├── src/
│   ├── consts.ts                 # サイトタイトル・説明文
│   ├── content.config.ts         # Markdownのfrontmatterスキーマ
│   ├── content/blog/             # 記事Markdown（自動生成 + 手動）
│   ├── components/
│   │   ├── Header.astro          # ヘッダー（ロゴ・ナビ）
│   │   └── Footer.astro
│   ├── layouts/
│   │   └── BlogPost.astro        # 記事ページのレイアウト
│   ├── pages/
│   │   ├── index.astro           # トップページ
│   │   ├── about.astro           # このサイトについて
│   │   └── blog/                 # 記事ルーティング
│   ├── styles/
│   │   └── global.css            # ブランドカラー定数等
│   └── assets/
│       └── featured.png          # 全記事共通アイキャッチ
├── .github/workflows/
│   ├── daily-posts.yml           # 毎日の生成→ビルド→デプロイ
│   └── deploy.yml                # 通常pushに反応するデプロイ（保険）
├── astro.config.mjs              # site URL / base path
└── package.json
```

---

## 4. よくある操作

### 手動で記事を生成して公開する

GitHubから手動トリガー:
1. <https://github.com/0305drystoryyuki/kakei-news/actions/workflows/daily-posts.yml>
2. 「Run workflow ▼」→「Run workflow」

ローカルから実行（WP投稿もしたい場合は`.env`にWP情報を追加してから）:
```bash
cd ~/kakei-news
set -a && source .env && set +a && npm run generate
git add src/content/blog && git commit -m "manual posts" && git push
```

### 新ブログだけ更新したい（WPには投稿しない）

`.env`からWP系の環境変数を外して実行:
```bash
cd ~/kakei-news
set -a && source .env && set +a
unset WP_URL WP_USERNAME WP_APP_PASSWORD
node scripts/generate-posts.mjs
git add src/content/blog && git commit -m "blog only" && git push
```

### 記事を1本削除する

```bash
rm src/content/blog/2026-MM-DD-N.md
rm src/content/blog/2026-MM-DD-N-kids.md
git add src/content/blog && git commit -m "remove" && git push
```

WordPress側は管理画面から手動で削除。

### 記事数を変更する

`scripts/generate-posts.mjs` の `MAX_POSTS_PER_DAY = 2` を編集してpush。

### 公開時刻を変更する

- 生成タイミング: cron-job.org のダッシュボードでスケジュール編集
- WP公開時刻: `scripts/generate-posts.mjs` の `PUBLISH_HOUR_JST = 9` を編集

### サイトのデザインを変更する

- カラー: `src/styles/global.css` の `--brand-*` 変数
- ヘッダー/ロゴ: `src/components/Header.astro`
- トップページ: `src/pages/index.astro`
- 記事レイアウト: `src/layouts/BlogPost.astro`

---

## 5. シークレット・認証情報

### GitHub Secrets （リポジトリ設定で管理）

<https://github.com/0305drystoryyuki/kakei-news/settings/secrets/actions>

| 名前 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API呼び出し |
| `WP_URL` | `https://kizukeba-itametahi.com` |
| `WP_USERNAME` | WordPressログインユーザー名（`yukiti.kanon`） |
| `WP_APP_PASSWORD` | WordPress アプリケーションパスワード |

ローテーションが必要になったら、各サービスで再発行 → Secrets画面でUpdate。

### 外部サービス

| サービス | 用途 | 管理画面 |
|---|---|---|
| **GitHub** | コード・GitHub Pages・GitHub Actions | <https://github.com/0305drystoryyuki/kakei-news> |
| **Anthropic Console** | Claude APIキー・課金 | <https://console.anthropic.com> |
| **cron-job.org** | 毎日の起動スケジューラー | <https://console.cron-job.org/> |
| **ConoHa WING** | WordPressホスティング | <https://www.conoha.jp/login/> |

ConoHaの「サイトセキュリティ → 海外アクセス制限」で **REST-APIのチェックを外している** こと（GitHub Actionsからの投稿に必要）。

---

## 6. コスト

| 項目 | 月額目安 |
|---|---|
| Claude API（Sonnet 4.5、4回/日 × 30日） | 約500〜1,000円 |
| GitHub Actions | 無料枠内（2000分/月、実使用は月60〜100分） |
| GitHub Pages | 無料 |
| cron-job.org | 無料 |
| **合計** | **約500〜1,000円/月** |

---

## 7. 既知の落とし穴と対処

### 自動実行が動かない / 遅延する

GitHub Actionsの内蔵cronは混雑時間帯（毎時0分付近）で1〜数時間遅延することがある。これを避けるために:
- メインの起動は **cron-job.org**（外部）
- GitHub Actions内蔵cronは7:17/8:17/9:17の3回（保険）

cron-job.orgの実行履歴は管理画面で確認可能。

### スクリプトがハングする

過去に発生したケース:
1. **WordPress fetch がタイムアウトせず無限待ち** → `scripts/generate-posts.mjs` 内に `AbortController` で30秒タイムアウト
2. **Claude APIが遅い / リトライ無限** → `new Anthropic({ timeout: 60_000, maxRetries: 1 })`
3. **Node.jsプロセスが終了しない** → `main().then(() => process.exit(0))` で明示的に終了

### ConoHaに弾かれる（403 Forbidden）

「海外アクセス制限 → REST-API」のチェックが入ると、GitHub Actions（海外IP）からのAPI呼び出しが弾かれる。OFF維持。

### 当日の記事が二重に作られる

スクリプト先頭で `2026-MM-DD-1.md` の存在チェックをしている。**JST基準で日付を判定** している（UTCで判定するとズレる過去バグがあった）。

### git pushが認証で詰まる

Macのキーチェーンに `0305drystoryyuki@github.com` のPersonal Access Tokenを保存済み。新しいMacなどに移行するときは:
```bash
git config --global credential.helper osxkeychain
# 初回push時にユーザー名（0305drystoryyuki）とPATを入力すれば以降記憶される
```

---

## 8. WordPressの予約投稿の仕組み

スクリプトは `status: "future"` + `date_gmt` を指定してWP REST APIで投稿している。

- 生成時刻: 毎朝8:00 JST
- 公開時刻: **当日9:00 JST**（既に過ぎていれば翌日9:00）

公開前に内容を確認して取り消したい場合は、WP管理画面の「投稿 → 予定」から該当記事を編集（下書きに戻す or 削除）。

---

## 9. 記事ペアのリンク仕組み

`src/content/blog/foo.md` の frontmatter に `kidsVersion: 'foo-kids'` を書いておくと、`src/layouts/BlogPost.astro` が「🧒 小学生でもわかるやさしい版はこちら →」のボタンを表示する。逆方向は `detailVersion: 'foo'`。

自動生成記事は両方向のリンクが自動で書き込まれる。手動コピー記事も同じ命名規則（`-kids` サフィックス）にしておけば一貫性が保てる。

---

## 10. トラブル時の連絡先

このリポジトリのIssuesに記録するか、Claudeに「kakei-newsの○○について」と聞けば本ドキュメントを参照しながら対応できます。
