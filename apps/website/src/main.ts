import '@fontsource-variable/outfit';
import './style.css';
import release from './release.json';

interface Release {
  version: string;
  file: string | null;
  url: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  builtAt: string | null;
  signed: boolean;
}

const r = release as Release;
const mb = r.sizeBytes ? `${Math.round(r.sizeBytes / 1048576)} MB` : null;
const href = r.url ?? (r.file ? `/${r.file}` : null);

for (const el of document.querySelectorAll<HTMLElement>('[data-release-short]')) {
  el.textContent = [`v${r.version}`, mb].filter(Boolean).join(' · ');
}
for (const el of document.querySelectorAll<HTMLElement>('[data-release-detail]')) {
  el.textContent = href
    ? [`Version ${r.version}`, mb, 'Windows 11 · 64-bit', r.builtAt ? `built ${new Date(r.builtAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` : null]
        .filter(Boolean)
        .join(' · ')
    : 'The installer has not been built yet. Run pnpm package:win, then rebuild this site.';
}
for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-download-link]')) {
  if (href) {
    link.href = href;
    if (r.file && !r.url) link.setAttribute('download', r.file.split('/').pop()!);
  } else {
    link.setAttribute('aria-disabled', 'true');
    link.classList.add('is-disabled');
    link.addEventListener('click', (e) => e.preventDefault());
  }
}

const shaWrap = document.querySelector<HTMLElement>('[data-sha-wrap]');
const sha = document.querySelector<HTMLElement>('[data-sha]');
if (r.sha256 && shaWrap && sha) {
  shaWrap.hidden = false;
  sha.textContent = r.sha256;
  document.querySelector<HTMLButtonElement>('[data-copy-sha]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(r.sha256!);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Select it';
    }
    setTimeout(() => (b.textContent = 'Copy'), 1400);
  });
}

for (const el of document.querySelectorAll<HTMLElement>('[data-year]')) el.textContent = String(new Date().getFullYear());

// Sticky nav gets a hairline once the page scrolls.
const nav = document.querySelector<HTMLElement>('[data-nav]');
const onScroll = () => nav?.classList.toggle('is-scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Fade sections in as they enter the viewport (instantly if IntersectionObserver is missing).
const reveals = document.querySelectorAll<HTMLElement>('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  reveals.forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`;
    io.observe(el);
  });
} else {
  reveals.forEach((el) => el.classList.add('is-in'));
}
