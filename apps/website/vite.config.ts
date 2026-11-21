import { defineConfig } from 'vite';

/**
 * HIRORA_SITE_URL=https://hirora.app (no trailing slash) makes the social-card
 * image and canonical link absolute, which link previews (WhatsApp, LinkedIn, X) need.
 */
const siteUrl = process.env.HIRORA_SITE_URL?.trim().replace(/\/+$/, '') ?? '';
if (siteUrl && !/^https:\/\//.test(siteUrl)) throw new Error('HIRORA_SITE_URL must start with https://');

export default defineConfig({
  build: { outDir: 'dist', assetsInlineLimit: 0 },
  preview: { port: 4317, strictPort: true },
  plugins: [
    {
      name: 'hirora-absolute-urls',
      transformIndexHtml(html) {
        if (!siteUrl) return html;
        return html
          .replace('content="/img/og.png"', `content="${siteUrl}/img/og.png"`)
          .replace('</title>', `</title>\n    <link rel="canonical" href="${siteUrl}/" />\n    <meta property="og:url" content="${siteUrl}/" />`);
      },
    },
  ],
});
