import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Multi-page site. Every page has `<!--@header-->` and `<!--@footer-->` placeholders that are
 * filled from partials/ at build time (so the pages never drift apart), with the current
 * page's nav link marked. HIRORA_SITE_URL=https://… makes canonical and social-card URLs absolute.
 */
const siteUrl = process.env.HIRORA_SITE_URL?.trim().replace(/\/+$/, '') ?? '';
if (siteUrl && !/^https:\/\//.test(siteUrl)) throw new Error('HIRORA_SITE_URL must start with https://');

export const PAGES = ['index', 'features', 'download', 'guide', 'privacy', 'faq', 'changelog'] as const;
const root = __dirname;
const partial = (name: string) => readFileSync(resolve(root, 'partials', `${name}.html`), 'utf8');

export default defineConfig({
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: { input: Object.fromEntries(PAGES.map((p) => [p, resolve(root, `${p}.html`)])) },
  },
  preview: { port: 4317, strictPort: true },
  plugins: [
    {
      name: 'hirora-partials',
      transformIndexHtml(html, ctx) {
        const page = basename(ctx.filename, '.html');
        const path = page === 'index' ? '/' : `/${page}`;
        const header = partial('header').replace(`data-page="${page}"`, `data-page="${page}" aria-current="page"`);
        let out = html.replace('<!--@header-->', header).replace('<!--@footer-->', partial('footer'));
        if (siteUrl) {
          out = out
            .replace('content="/img/og.png"', `content="${siteUrl}/img/og.png"`)
            .replace('</title>', `</title>\n    <link rel="canonical" href="${siteUrl}${path}" />\n    <meta property="og:url" content="${siteUrl}${path}" />`);
        }
        return out;
      },
    },
  ],
});
