import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			// 出典情報（自動生成記事で使用）
			sourceName: z.string().optional(),
			sourceUrl: z.string().optional(),
			// 記事ペア用（詳細版 ⇔ 小学生向け版）
			kidsVersion: z.string().optional(), // 小学生向け版のslug
			detailVersion: z.string().optional(), // 詳細版のslug
		}),
});

export const collections = { blog };
