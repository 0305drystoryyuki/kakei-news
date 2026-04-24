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
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'src/content/blog');

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
				description: 'Markdown形式の本文。見出しは ## から使う。800〜1200字程度',
			},
		},
		required: ['title', 'description', 'body'],
	},
};

const STYLE_PROMPTS = {
	detail: `あなたは子育て世帯向けの家計ブログの編集者です。以下のニュースを元に、シングルファザーや子育て家庭の読者が読みやすい「詳細版」ブログ記事を日本語で書いてください。

# 要件
- 800〜1200字程度
- 子育て家庭への影響を必ず含める
- 難しい制度名は噛み砕いて説明
- 最後に「家計へのポイント」3つを箇条書き
- 元記事の文章をそのまま転載しない（要約＋独自解説）`,

	kids: `あなたは子育て世帯向けの家計ブログの編集者です。以下のニュースを元に、**小学生でも理解できるやさしい言葉**でブログ記事を日本語で書いてください。

# 要件
- 600〜900字程度
- 専門用語は絶対に使わず、使う場合は必ず「○○っていうのはね…」と説明
- 例え話や身近なシチュエーション（お小遣い、コンビニ、お菓子など）を使って説明
- 「〜だよ」「〜なんだ」といった柔らかい文末
- 最後に「おうちでの会話のタネに」として、家族で話せる質問2〜3個を箇条書き
- タイトルの頭に「【やさしい版】」を付ける`,
};

async function generateArticle(client, item, style) {
	const stylePrompt = STYLE_PROMPTS[style];
	const prompt = `${stylePrompt}

# 元ニュース
- タイトル: ${item.title}
- 出典: ${item.source}
- URL: ${item.link}
- 概要: ${item.contentSnippet}

write_blog_articleツールを使って記事を出力してください。`;

	const resp = await client.messages.create({
		model: MODEL,
		max_tokens: 2500,
		tools: [ARTICLE_TOOL],
		tool_choice: { type: 'tool', name: 'write_blog_article' },
		messages: [{ role: 'user', content: prompt }],
	});

	const toolUse = resp.content.find((b) => b.type === 'tool_use');
	if (!toolUse) throw new Error('Claudeがツール呼び出しを返しませんでした');
	return toolUse.input;
}

/**
 * ファイル名用のスラッグを生成
 */
function slugify(date, index) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}-${index}`;
}

/**
 * Markdownファイルとして保存（詳細版/やさしい版のペア対応）
 */
async function writePost({ article, item, slug, pairedSlug, style }) {
	await fs.mkdir(OUTPUT_DIR, { recursive: true });
	const iso = new Date().toISOString();
	const escapedTitle = article.title.replace(/'/g, "''");
	const escapedDesc = article.description.replace(/'/g, "''");
	const frontmatterLines = [
		'---',
		`title: '${escapedTitle}'`,
		`description: '${escapedDesc}'`,
		`pubDate: '${iso}'`,
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

async function main() {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		console.error('ANTHROPIC_API_KEY が未設定です');
		process.exit(1);
	}
	const client = new Anthropic({ apiKey });

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

			// やさしい版
			const kids = await generateArticle(client, item, 'kids');
			const kidsPath = await writePost({
				article: kids,
				item,
				slug: kidsSlug,
				pairedSlug: detailSlug,
				style: 'kids',
			});
			console.log(`  ✔ やさしい版: ${path.relative(ROOT, kidsPath)}`);
		} catch (err) {
			console.error(`  ✖ 失敗: ${err.message}`);
		}
	}
	console.log('\n完了');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
