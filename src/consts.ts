// Place any global data in this file.
// You can import this data from anywhere in your site by using the `import` keyword.

export const SITE_TITLE = '家計ニュース｜子育て家庭のお金情報まとめ';
export const SITE_DESCRIPTION =
	'子どものいる家庭向けに、制度改正・補助金・家計術などお金に関するニュースを毎日自動でお届けします。';

// 家計ニュースから、ゆきちさん自身の発信へつなぐ公式導線。
// URLを変えるときはここだけ直せば、ヘッダー・記事末・フッターへ反映されます。
export const EXTERNAL_LINKS = {
	wordpress: 'https://kizukeba-itametahi.com/',
	note: 'https://note.com/shinpapa_kakeibo',
	youtube: 'https://www.youtube.com/channel/UCokQAECkDGtNF6lHtPLdwsA',
} as const;
