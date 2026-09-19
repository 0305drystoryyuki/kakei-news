# kids-scripts/ ＝ 台本置き場（サイト非公開）

ちびっ子向けYouTubeの**語り台本**（5,000〜10,000字）をここに貯めていく。
`scripts/generate-posts.mjs` が毎朝1記事につき1本、自動で書き出す。

- **サイトには出ない。** Astroのコンテンツコレクションは `src/content/blog` だけを読む
  （`src/content.config.ts` の `glob({ base: './src/content/blog' })`）。
  このフォルダは `src/content/` の外にあるので、`npm run build` しても `dist/` には出力されない。
- ここは**YouTube台本の源泉**。サイトに出る「【やさしい版】」記事は、この台本を
  1,500〜2,000字に要約したもの（2段生成）。
- ファイル名は `YYYY-MM-DD-N.md`（Nは大人版と同じ連番）。
- frontmatter: `title` / `date` / `sourceTitle` / `sourceUrl` / `articleSlug`（対応する `-kids` 記事のslug）

> ⚠️ このリポジトリは**公開（public）**なので、台本もGitHub上では誰でも読める。
> 公開したくない下書きをここに置かないこと。
