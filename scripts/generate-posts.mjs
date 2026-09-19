/**
 * 毎日RSSからニュースを2件取得し、Claudeで要約してMarkdown記事を生成するスクリプト。
 *
 * 前提:
 *   - 環境変数 ANTHROPIC_API_KEY にClaude APIキーを設定しておくこと
 *   - src/content/blog/ にMarkdownが書き出される
 *
 * 使い方:
 *   node scripts/generate-posts.mjs
 */

import Anthropic from '@anthropic-ai/sdk';
import Parser from 'rss-parser';
import { marked } from 'marked';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'src/content/blog');
// ちびっ子向けYouTube台本の置き場。`src/content/` の外にあるので Astro のコンテンツ
// コレクション（glob base: ./src/content/blog）には拾われず、サイトにはビルドされない。
const KIDS_SCRIPTS_DIR = path.join(ROOT, 'kids-scripts');

// 子育て家庭向けに厳選したRSSソース
const RSS_FEEDS = [
	{
		name: 'NHKニュース 経済',
		url: 'https://www.nhk.or.jp/rss/news/cat5.xml',
	},
	{
		name: 'NHKニュース 暮らし',
		url: 'https://www.nhk.or.jp/rss/news/cat2.xml',
	},
	{
		name: '朝日新聞 経済',
		url: 'https://www.asahi.com/rss/asahi/business.rdf',
	},
	{
		name: 'Yahoo!ニュース 経済',
		url: 'https://news.yahoo.co.jp/rss/topics/business.xml',
	},
	{
		name: '厚生労働省 新着情報',
		url: 'https://www.mhlw.go.jp/stf/news.rdf',
	},
];

// 子育て家庭向けに関連度の高いキーワード
const KEYWORDS = [
	'子ども', '子育て', '児童', '教育', '保育', '学校', '大学',
	'家計', '年金', '税', '社会保険', '医療費', '補助', '給付', '手当',
	'NISA', 'iDeCo', '投資', '貯蓄', '節約',
	'物価', '賃金', '最低賃金', '電気代', 'ガス代', '食品',
	'住宅', '住居', '住宅ローン',
	'働き方', '育休', '産休', '介護',
];

const MAX_POSTS_PER_DAY = 2;
const MODEL = 'claude-sonnet-4-5';
const ARTICLE_MAX_TOKENS = 4000; // 記事（詳細版・やさしい版）用
const KIDS_SCRIPT_MAX_TOKENS = 16000; // 台本用（5,000〜10,000字を出しきるため）

// 公開サイトのURL（詳細版へのリンクに使用）
const SITE_BASE_URL = 'https://0305drystoryyuki.github.io/kakei-news';

// WordPress設定
const WP_CATEGORY_ID = 9; // 「お勉強」カテゴリ
const WP_FEATURED_MEDIA_ID = 336; // アイキャッチ画像のメディアID
// 'draft' = 下書き / 'future' = 予約投稿（PUBLISH_HOUR_JST に自動公開）/ 'publish' = 即公開
const WP_STATUS = 'future';
const PUBLISH_HOUR_JST = 9; // 当日の何時(JST)に公開するか

// 新ブログ用アイキャッチ画像（IF世界線シリーズからランダム選択）
// 抽選対象を明示リストで管理する（連番の自動生成はしない）。
// - if_01 は別ブログ用の画像が混入していたため削除済み（2026-09-15）
// - if_09/10/11/12/34/36 は他の番号と同一バイトの重複なので抽選から除外（既存記事の参照用にファイルは残す）
// 画像を追加するときは、あゆみ先輩のIF世界線画像であることを目視確認してからこのリストに足す。
const IF_WORLD_HERO_IMAGES = [
	'if_02', 'if_03', 'if_04', 'if_05', 'if_06', 'if_07', 'if_08',
	'if_13', 'if_14', 'if_15', 'if_16', 'if_17', 'if_18', 'if_19', 'if_20',
	'if_21', 'if_22', 'if_23', 'if_24', 'if_25', 'if_26', 'if_27', 'if_28',
	'if_29', 'if_30', 'if_31', 'if_32', 'if_33', 'if_35',
];
function getRandomHeroImage() {
	const name = IF_WORLD_HERO_IMAGES[Math.floor(Math.random() * IF_WORLD_HERO_IMAGES.length)];
	return `../../assets/if_world/${name}.png`;
}

/**
 * RSSを全フィード取得してフラットな記事配列に
 */
async function fetchAllFeeds() {
	const parser = new Parser({ timeout: 15000 });
	const all = [];
	for (const feed of RSS_FEEDS) {
		try {
			const data = await parser.parseURL(feed.url);
			for (const item of data.items || []) {
				all.push({
					source: feed.name,
					title: item.title || '',
					link: item.link || '',
					pubDate: item.pubDate || item.isoDate || '',
					contentSnippet: item.contentSnippet || item.content || '',
				});
			}
		} catch (err) {
			console.warn(`[warn] ${feed.name} の取得失敗: ${err.message}`);
		}
	}
	return all;
}

/**
 * キーワードマッチで子育て家庭に関連する記事を抽出
 */
function filterRelevant(items) {
	return items.filter((item) => {
		const text = `${item.title} ${item.contentSnippet}`;
		return KEYWORDS.some((kw) => text.includes(kw));
	});
}

/**
 * 既に記事化したURLを取得（重複防止）
 */
async function getExistingUrls() {
	const files = await fs.readdir(OUTPUT_DIR).catch(() => []);
	const urls = new Set();
	for (const f of files) {
		if (!f.endsWith('.md')) continue;
		const content = await fs.readFile(path.join(OUTPUT_DIR, f), 'utf8');
		const match = content.match(/sourceUrl:\s*['"]?(.+?)['"]?\s*$/m);
		if (match) urls.add(match[1].trim());
	}
	return urls;
}

/**
 * Claudeのtool useで構造化された記事を取得
 */
const ARTICLE_TOOL = {
	name: 'write_blog_article',
	description: '子育て家庭向けのブログ記事を書く',
	input_schema: {
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description: 'ブログ記事のタイトル（30字以内、読者が読みたくなるもの）',
			},
			description: {
				type: 'string',
				description: 'SNS用の説明文（80字以内）',
			},
			body: {
				type: 'string',
				description: 'Markdown形式の本文。見出しは ## から使う。800〜1200字程度（スタイル側の指示で字数が指定されている場合は、そちらを優先する）',
			},
		},
		required: ['title', 'description', 'body'],
	},
};

/**
 * 台本（ちびっ子向けYouTubeの語り台本）用のtool定義。
 * 記事用の write_blog_article とは別物（descriptionを持たず、本文がとても長い）。
 */
const KIDS_SCRIPT_TOOL = {
	name: 'write_kids_script',
	description: 'ちびっ子向けYouTubeの語り台本を書く',
	input_schema: {
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description: '動画タイトルとして成立する形（30字以内）。「【やさしい版】」は付けない',
			},
			body: {
				type: 'string',
				description: 'Markdown形式の台本本文。見出しは ## から使う。5,000〜10,000字',
			},
		},
		required: ['title', 'body'],
	},
};

const KIDS_SCRIPT_PROMPT = `あなたは、ちびっ子向けYouTubeチャンネルの構成作家です。
以下のニュースを題材に、小学校高学年〜中学生に語りかける**語り台本**を日本語で書いてください。
これはYouTube動画の語りの源泉です。ブログ記事ではないので、長さを惜しまず、たっぷり書いてください。

# 長さ（最重要）
- 本文は **5,000〜10,000字**。短くまとめようとしないこと
- 足りないと感じたら、「たとえば」の場面描写をもっと具体的にして伸ばす。説明の繰り返しで水増ししない

# 語りのルール
- 1文は短く。40字を超えそうなら2文に分ける
- 文末は「〜だよ」「〜なんだ」でやわらかく
- 専門用語は使わない。どうしても必要なら必ず「○○っていうのはね…」と説明してから使う
- ふりがなは振らない（漢字は小学校高学年が読める範囲で使う）
- 実在の店名・ブランド名・商品名は出さない（「コンビニのおにぎり」「ゲームのガチャ」のように一般名詞で書く）
- 自分で換算・概算した数字（「○回ぶん」「○倍」「1家族あたり○円」など）を使った文には、必ず同じ段落に「※金額はイメージだよ」を添える
- 「友だちからお金を借りて返す」型の例は使わない
- 同じ例えの使い回しは禁止。毎回ニュースの中身に合った例を考える

# 構成（この順番で書く。見出しは ## を使う）
1. 「## オープニング」── ニュースを一言で。何が起きたかを3〜5文。むずかしい言葉はここで説明しておく
2. **「なぜ？」を3〜4個**。それぞれ「## なぜ①　◯◯」の形で見出しを立てる
   - 軸の例：こまる側／うれしい側／どうしてそうなるのかの仕組み／これからどうなる
   - 各「なぜ」には**必ず「たとえば」を2つ**入れる
     - たとえば① ＝ **家の中の例**（おこづかい・給食費・家族のスマホ代・冷蔵庫の中・お年玉 など）
     - たとえば② ＝ **外の世界の例**（町のお店・工場・学校・市役所・はたらく大人 など）
     - **1例300〜500字**。登場人物が迷ったり決めたりする「場面が動くまで」書く。結論のラベルで終わらせない
     - 小見出しは「**たとえば①　◯◯**」の形で太字にする
3. 「## 数字を身近にしてみると」── お小遣い500円／給食費／コンビニのおにぎりへの換算を**2〜3本**。兆・億など大きすぎる数字は、1世帯あたり・1人あたりに割ってから置きかえる
4. 「## いいこと・こまることの整理」── メリットとデメリットを箇条書きで左右対称に整理する
5. 「## じゃあ、うちはどうする？」── **太字の問いかけ1つ**＋家族で話せる質問3個を箇条書き
6. 「## しめの一言」── 最後にひとこと、やさしく背中を押して終わる

write_kids_scriptツールを使って台本を出力してください。`;

const STYLE_PROMPTS = {
	detail: `あなたは「シンパパ家計研究所」のゆきちさん（40代シンパパ）として、子育て世帯向けの家計ブログ記事を書きます。
記事スタイルは「あゆみ先輩なら、こう教えてくれたかな」シリーズ。
現代のゆきちさんが今日のニュースを見て、若き日（17歳高校生時代）のバイト先の先輩・東條あゆみさんを思い出しながら解説する形式です。

# キャラクター設定
- **現代のゆきち（40代・シンパパ）**：実体験ベース、関西弁混じり、家計研究所運営者
- **若き日のゆきち（高校生時代）**：素朴・関西弁、「〜っすか」「〜やね」
- **あゆみ先輩（当時の大学生・架空ファーストフード店マネジャー）**：清楚奥手、優しく解説、関西弁混じり

## 会話表記ルール
本文中の会話は以下の形式で書く（年齢は付けない、シンプルに）：
- **ゆきち**「セリフ」
- **あゆみ**「セリフ」

# 構造（必ずこの順番で書く）
1. 冒頭：「シンパパ家計研究所のゆきちです。」と名乗り、その下に \`*※アイキャッチのキャラ画像はイメージです*\` と1行入れる
2. 現代のゆきちが今日のニュースを見て考える（150〜200字）
3. 「あの時のあゆみ先輩なら、どう教えてくれたやろうな」と回想開始（引用ブロック \`>\` で書く）
4. 「## ──架空ファーストフード店、休憩室にて──」見出し
5. ゆきちとあゆみ先輩の会話形式でニュース解説（400〜600字）
6. 数字は ## 見出し＋表で整理（読みやすさ優先）
7. 「## ──現代に戻って──」で現代のゆきちパートに戻る
8. シンパパ家計研究所の3本柱（固定費見直し・ふるさと納税・iDeCo/NISA）と関連付け
9. 「## まとめ」で要点を箇条書き
10. 締め：「勇気ある行動が、日々の生活を豊かにする。」改行「ゆきち」で終わる

# 重要なルール
- 本文中に \`[挿絵：〇〇]\` のような挿絵指示は書かない（アイキャッチで代用）
- 「※イメージです」は冒頭に1回だけ（イタリック表記）
- 高校生・大学生時代の回想シーンでは2026年の最新制度（新NISA・iDeCoなど）には触れない
- 最新制度は「現代のゆきち（40代）」のパートで補足する形
- 元記事の文章をそのまま転載しない（要約＋独自解説）
- 800〜1200字程度
- 架空ファーストフード店設定（実在ブランド名・商品名は出さない）

# 出力例の冒頭
\`\`\`
シンパパ家計研究所のゆきちです。

*※アイキャッチのキャラ画像はイメージです*

[現代の時事ネタ150-200字]

40代になった今、家計簿とにらめっこしながらこう思う。

> あの時のあゆみ先輩なら、このニュースを今どう解説してくれるんやろう。

## ──架空ファーストフード店、休憩室にて──

**ゆきち**「あゆみさん、ちょっと聞きたいんすけど…」
**あゆみ**「うん、…」
\`\`\``,

	kids: `あなたは子育て世帯向けの家計ブログの編集者です。**小学校高学年〜中学生がひとりで読めるやさしい言葉**でブログ記事を日本語で書いてください。

# 基本ルール
- 本文は**1,500〜2,000字**（write_blog_articleツールの説明にある800〜1200字より、この指定を優先する）
- 執筆後に文字数を数え直し、1,500字に届いていなければ「たとえば」と「数字を身近に」を厚くし、2,000字を超えていたら重複している説明を削る
- 1文は短く。40字を超えそうなら2文に分ける
- 専門用語は使わない。どうしても必要なら必ず「○○っていうのはね…」と説明してから使う
- 文末は「〜だよ」「〜なんだ」でやわらかく
- ふりがなは振らない（漢字は小学校高学年が読める範囲で使う）
- 実在の店名・ブランド名・商品名は出さない（「コンビニのおにぎり」「ゲームのガチャ」のように一般名詞で書く）
- タイトルの頭に「【やさしい版】」を付ける（タイトル全体で30字以内）
- 「友だちからお金を借りて返す」型の例は使わない（過去に多用したため）
- 同じ例えの使い回しは禁止。毎回ニュースの中身に合った例を考える
- 自分で換算・概算した数字（「○回ぶん」「○倍」「1家族あたり○円」など）を使った文には、必ず同じ段落に「※金額はイメージだよ」を添える

# 記事の型（A案＝標準。この見出しの順番で書く）
1. 「## ニュースを一言でいうと」── 何が起きたかを3〜5文。むずかしい言葉はここで説明しておく
2. 「## なぜ①　◯◯」（こまる側）── 2〜3文の導入のあと、「**たとえば①　◯◯**」「**たとえば②　◯◯**」の小見出しで例を2つ。**各200〜300字**。1つの小さな物語になるまで書く（「パン屋さんがオーブンを買うのをやめる」のように場面が動くところまで）
3. 「## なぜ②　◯◯」（うれしい側）── 同じく導入＋「たとえば①」「たとえば②」（各200〜300字）
   - うれしい側の例を2つ作れないニュースなら、なぜ②を「じゃあ、どうやって防ぐ？」「だれが助けてくれるの？」などに置きかえてよい
4. 「## 数字を身近にしてみると」── お小遣い500円／給食費／コンビニのおにぎりへの換算を1〜2行＋補足。兆・億は1世帯あたり・1人あたりに割ってから置きかえる
5. 「## じゃあ、うちはどうする？」── **太字の問いかけ1つ**＋その下に家族で話せる質問2個を箇条書き。感想を聞く問いではなく、家族がその場で1つ決められる問いにする

# 受け皿（B案）── 次のときだけA案の代わりに使う
- 制度変更や新しい補助金など、対象者が多岐にわたる話
- 賛否が割れる／立場によって評価が逆になる話
- うれしい側の「たとえば」を2つ作れない話
B案の型：「なぜ」を2つ立て、それぞれの下に **いいこと** と **こまること** を置き、各2例を1〜2文の箇条書きで書く。
B案の必須ルール：**2文で言い切れない論点は入れない**（理屈が2段以上あるものは切る）。8個そろえることを目的にしない。6個でも、言い切れる6個を選ぶ。地の文（各「なぜ」の導入）を各2段落しっかり書かないと1,500字を割る。

# 「たとえば」の濃さの見本（A案）
**たとえば②　町のパン屋さんの「お店の借金」**

こまるのは、おうちだけじゃないんだ。町のパン屋さんを想像してみて。オーブンを新しくしたいとき、お店の人も銀行からお金を借りるんだよ。金利が上がると、その借りたお金を返すのが大変になる。するとお店の人は、こう考えるんだ。「オーブンは、もう少しがまんしようかな」って。新しいオーブンが売れなければ、オーブンを作る工場の仕事も減る。こうやって、金利の話はお店や工場にも広がっていくんだ。`,
};

/**
 * 記事を生成する。
 * kidsScript を渡すと「台本を1,500〜2,000字に要約する」モードになる（2段生成の2段目）。
 * 渡さなければ従来どおりニュースから直接書く（フォールバック経路）。
 */
async function generateArticle(client, item, style, kidsScript = null) {
	const stylePrompt = STYLE_PROMPTS[style];
	const scriptSection = kidsScript
		? `

# 下敷きにする台本（YouTube用の長い語り台本）
この台本の内容を **1,500〜2,000字に要約** して記事にしてください。
- 台本にない事実を足さない
- 「たとえば」は台本の中から記事の型に合うものを選び、200〜300字に刈り込む（場面は残す）
- 台本の見出しをそのまま写すのではなく、上の「記事の型」の見出しに組み直す

--- 台本ここから ---
${kidsScript.body}
--- 台本ここまで ---`
		: '';

	const prompt = `${stylePrompt}

# 元ニュース
- タイトル: ${item.title}
- 出典: ${item.source}
- URL: ${item.link}
- 概要: ${item.contentSnippet}${scriptSection}

write_blog_articleツールを使って記事を出力してください。`;

	const resp = await client.messages.create({
		model: MODEL,
		max_tokens: ARTICLE_MAX_TOKENS,
		tools: [ARTICLE_TOOL],
		tool_choice: { type: 'tool', name: 'write_blog_article' },
		messages: [{ role: 'user', content: prompt }],
	});

	const toolUse = resp.content.find((b) => b.type === 'tool_use');
	if (!toolUse) throw new Error('Claudeがツール呼び出しを返しませんでした');
	return toolUse.input;
}

/**
 * ちびっ子向けYouTube台本（5,000〜10,000字）を生成する（2段生成の1段目）。
 * max_tokens で途中で切れた場合は1回だけリトライし、それでも切れたら null を返す。
 * null のときは呼び出し側が従来の1段生成にフォールバックするので、記事が出ない事故にはならない。
 */
async function generateKidsScript(client, item) {
	const prompt = `${KIDS_SCRIPT_PROMPT}

# 元ニュース
- タイトル: ${item.title}
- 出典: ${item.source}
- URL: ${item.link}
- 概要: ${item.contentSnippet}

write_kids_scriptツールを使って台本を出力してください。`;

	for (let attempt = 1; attempt <= 2; attempt++) {
		const resp = await client.messages.create({
			model: MODEL,
			max_tokens: KIDS_SCRIPT_MAX_TOKENS,
			tools: [KIDS_SCRIPT_TOOL],
			tool_choice: { type: 'tool', name: 'write_kids_script' },
			messages: [{ role: 'user', content: prompt }],
		});
		if (resp.stop_reason === 'max_tokens') {
			console.warn(`  ! 台本が max_tokens で切れました（${attempt}回目）`);
			continue;
		}
		const toolUse = resp.content.find((b) => b.type === 'tool_use');
		if (!toolUse || !toolUse.input || !toolUse.input.body) {
			console.warn(`  ! 台本のツール出力が空でした（${attempt}回目）`);
			continue;
		}
		return toolUse.input;
	}
	return null;
}

/**
 * ファイル名用のスラッグを生成（JST基準）
 */
function slugify(date, index) {
	// UTC→JSTに変換（+9時間）
	const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
	const y = jst.getUTCFullYear();
	const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
	const d = String(jst.getUTCDate()).padStart(2, '0');
	return `${y}-${m}-${d}-${index}`;
}

/**
 * Markdownファイルとして保存（詳細版/やさしい版のペア対応）
 */
async function writePost({ article, item, slug, pairedSlug, style }) {
	await fs.mkdir(OUTPUT_DIR, { recursive: true });
	// JST タイムゾーン明示で保存（Astro が UTC で解釈して日付ズレるのを防ぐ）
	const now = new Date();
	const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	const iso = jst.toISOString().slice(0, 19) + '+09:00';
	const escapedTitle = article.title.replace(/'/g, "''");
	const escapedDesc = article.description.replace(/'/g, "''");
	const frontmatterLines = [
		'---',
		`title: '${escapedTitle}'`,
		`description: '${escapedDesc}'`,
		`pubDate: '${iso}'`,
		`heroImage: '${getRandomHeroImage()}'`,
		`sourceName: '${item.source}'`,
		`sourceUrl: '${item.link}'`,
	];
	// 詳細版なら kidsVersion、やさしい版なら detailVersion
	if (style === 'detail' && pairedSlug) {
		frontmatterLines.push(`kidsVersion: '${pairedSlug}'`);
	} else if (style === 'kids' && pairedSlug) {
		frontmatterLines.push(`detailVersion: '${pairedSlug}'`);
	}
	frontmatterLines.push('---', '');
	const frontmatter = frontmatterLines.join('\n');
	const footer = [
		'',
		'---',
		'',
		`※本記事はAIが[${item.source}](${item.link})の公開情報を元に要約・解説したものです。正確な情報は元記事をご確認ください。`,
		'',
	].join('\n');
	const filePath = path.join(OUTPUT_DIR, `${slug}.md`);
	await fs.writeFile(filePath, frontmatter + article.body + footer, 'utf8');
	return filePath;
}

/**
 * 台本を kids-scripts/ に保存する。
 * ここは `src/content/` の外なので Astro のビルド対象にならない（= サイトには出ない）。
 * YouTube台本の源泉として置いておくだけ。
 */
async function writeKidsScript({ script, item, slug, articleSlug, date }) {
	await fs.mkdir(KIDS_SCRIPTS_DIR, { recursive: true });
	const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
	const iso = jst.toISOString().slice(0, 19) + '+09:00';
	const esc = (s) => String(s ?? '').replace(/'/g, "''");
	const frontmatter = [
		'---',
		`title: '${esc(script.title)}'`,
		`date: '${iso}'`,
		`sourceTitle: '${esc(item.title)}'`,
		`sourceUrl: '${esc(item.link)}'`,
		`articleSlug: '${esc(articleSlug)}'`,
		'---',
		'',
	].join('\n');
	const filePath = path.join(KIDS_SCRIPTS_DIR, `${slug}.md`);
	await fs.writeFile(filePath, frontmatter + script.body + '\n', 'utf8');
	return filePath;
}

/**
 * WordPress予約投稿の公開日時（GMT）を計算
 * 当日のJST PUBLISH_HOUR_JST 時。既に過ぎていれば翌日。
 * 戻り値は WP API が要求する `YYYY-MM-DDTHH:MM:SS` 形式（UTC）
 */
function computePublishDateGmt() {
	const now = new Date();
	const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	// 当日(JST)の PUBLISH_HOUR_JST 時 を UTC で構築
	const target = new Date(
		Date.UTC(
			jstNow.getUTCFullYear(),
			jstNow.getUTCMonth(),
			jstNow.getUTCDate(),
			PUBLISH_HOUR_JST - 9, // JST -> UTC
			0,
			0,
		),
	);
	if (target.getTime() <= now.getTime()) {
		target.setUTCDate(target.getUTCDate() + 1);
	}
	return target.toISOString().replace(/\.\d+Z$/, '');
}

/**
 * WordPressにやさしい版の記事を投稿する（下書き or 予約）
 */
async function postToWordPress({ kidsArticle, detailSlug, item }) {
	const wpUrl = process.env.WP_URL;
	const wpUser = process.env.WP_USERNAME;
	const wpPass = process.env.WP_APP_PASSWORD;
	if (!wpUrl || !wpUser || !wpPass) {
		console.log('  → WP設定なしのためスキップ');
		return null;
	}

	// Markdown → HTML変換
	const bodyHtml = marked.parse(kidsArticle.body);

	// 詳細版への誘導リンクをフッターに追加
	const detailUrl = `${SITE_BASE_URL}/blog/${detailSlug}/`;
	const footer = `
<hr>
<p>📖 <strong>もっと詳しく知りたい方へ</strong><br>
大人向けの詳細版を家計ニュースブログで公開中。制度の詳細や家計への具体的な影響を深掘りしています。<br>
<a href="${detailUrl}" target="_blank" rel="noopener">▶ 詳細版を読む</a></p>
<p><small>※本記事はAIが<a href="${item.link}" target="_blank" rel="noopener">${item.source}</a>の公開情報を元に要約したものです。正確な情報は元記事をご確認ください。</small></p>
`;

	const endpoint = `${wpUrl.replace(/\/$/, '')}/wp-json/wp/v2/posts`;
	const auth = Buffer.from(`${wpUser}:${wpPass.replace(/\s/g, '')}`).toString('base64');

	// 30秒でタイムアウト（fetchはデフォルトでは無限に待つ）
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 30000);
	let resp;
	try {
		resp = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Basic ${auth}`,
			},
			body: JSON.stringify({
				title: kidsArticle.title,
				content: bodyHtml + footer,
				excerpt: kidsArticle.description,
				status: WP_STATUS,
				categories: [WP_CATEGORY_ID],
				featured_media: WP_FEATURED_MEDIA_ID,
				...(WP_STATUS === 'future' ? { date_gmt: computePublishDateGmt() } : {}),
			}),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeoutId);
	}
	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`WP投稿失敗 ${resp.status}: ${text.slice(0, 200)}`);
	}
	const data = await resp.json();
	return { id: data.id, link: data.link };
}

async function main() {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		console.error('ANTHROPIC_API_KEY が未設定です');
		process.exit(1);
	}

	// 多重cron用の重複防止: 今日の記事 (YYYY-MM-DD-1.md) が既にあれば終了
	const todayCheck = new Date();
	const todaySlug = slugify(todayCheck, 1);
	const todayFile = path.join(OUTPUT_DIR, `${todaySlug}.md`);
	try {
		await fs.access(todayFile);
		console.log(`今日の記事 (${todaySlug}.md) は既に生成済み。スキップして終了。`);
		return;
	} catch {
		// ファイルなし、続行
	}

	const client = new Anthropic({
		apiKey,
		timeout: 60_000, // 60秒タイムアウト（デフォルトは10分）
		maxRetries: 1, // リトライ1回まで（デフォルト2回）
	});

	console.log('RSS取得中...');
	const items = await fetchAllFeeds();
	console.log(`  → ${items.length}件取得`);

	const relevant = filterRelevant(items);
	console.log(`子育て/家計関連: ${relevant.length}件`);

	const existingUrls = await getExistingUrls();
	const fresh = relevant.filter((i) => i.link && !existingUrls.has(i.link));
	console.log(`未記事化: ${fresh.length}件`);

	// 新しいものを優先（pubDate降順）
	fresh.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
	const picks = fresh.slice(0, MAX_POSTS_PER_DAY);

	if (picks.length === 0) {
		console.log('新しい対象記事なし。終了。');
		return;
	}

	const today = new Date();
	for (let i = 0; i < picks.length; i++) {
		const item = picks[i];
		const detailSlug = slugify(today, i + 1);
		const kidsSlug = `${detailSlug}-kids`;
		console.log(`\n[${i + 1}/${picks.length}] ${item.source}: ${item.title}`);
		try {
			// 詳細版
			const detail = await generateArticle(client, item, 'detail');
			const detailPath = await writePost({
				article: detail,
				item,
				slug: detailSlug,
				pairedSlug: kidsSlug,
				style: 'detail',
			});
			console.log(`  ✔ 詳細版: ${path.relative(ROOT, detailPath)}`);

			// ちびっ子向けYouTube台本（5,000〜10,000字・サイトには出さない）
			let kidsScript = null;
			try {
				kidsScript = await generateKidsScript(client, item);
				if (kidsScript) {
					const scriptPath = await writeKidsScript({
						script: kidsScript,
						item,
						slug: detailSlug,
						articleSlug: kidsSlug,
						date: today,
					});
					console.log(
						`  ✔ 台本: ${path.relative(ROOT, scriptPath)} (${kidsScript.body.length}字)`,
					);
				} else {
					console.warn('  ! 台本を作れませんでした。やさしい版は従来の1段生成にフォールバックします');
				}
			} catch (scriptErr) {
				console.error(`  ✖ 台本生成エラー: ${scriptErr.message}（1段生成にフォールバック）`);
				kidsScript = null;
			}

			// やさしい版（台本があればそれを要約、なければニュースから直接）
			const kids = await generateArticle(client, item, 'kids', kidsScript);
			const kidsPath = await writePost({
				article: kids,
				item,
				slug: kidsSlug,
				pairedSlug: detailSlug,
				style: 'kids',
			});
			console.log(`  ✔ やさしい版: ${path.relative(ROOT, kidsPath)}`);

			// WordPressにやさしい版を下書き投稿
			try {
				const wpResult = await postToWordPress({
					kidsArticle: kids,
					detailSlug,
					item,
				});
				if (wpResult) {
					console.log(`  ✔ WP下書き: ${wpResult.link} (ID: ${wpResult.id})`);
				}
			} catch (wpErr) {
				console.error(`  ✖ WP投稿エラー: ${wpErr.message}`);
			}
		} catch (err) {
			console.error(`  ✖ 失敗: ${err.message}`);
		}
	}
	console.log('\n完了');
}

// テストから import できるように公開する
export {
	ARTICLE_TOOL,
	KIDS_SCRIPT_TOOL,
	KIDS_SCRIPT_PROMPT,
	KIDS_SCRIPTS_DIR,
	OUTPUT_DIR,
	STYLE_PROMPTS,
	generateArticle,
	generateKidsScript,
	writeKidsScript,
	writePost,
	slugify,
	main,
};

// 直接実行されたときだけ動かす（import しただけでは走らない）
const invokedDirectly =
	process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
	main()
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}
