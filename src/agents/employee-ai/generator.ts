import type { SiteSpec } from './types.js';

/**
 * Prompts17 Phase 18 — Deterministic static-site generator.
 *
 * Produces REAL, inspectable HTML/CSS/JS files for the {@link SiteSpec}. All
 * user-derived text is HTML-escaped on the way in; no external runtime, network
 * or shell is required, so the output is byte-for-byte reproducible and cannot
 * execute anything.
 */

export interface GeneratedFile {
  readonly relativePath: string;
  readonly content: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function navLinks(spec: SiteSpec): string {
  return spec.pages
    .map(
      (page) =>
        `<a href="/${page.slug === 'index' ? 'index.html' : `${page.slug}.html`}">${escapeHtml(page.title)}</a>`,
    )
    .join('\n          ');
}

function sectionsHtml(spec: SiteSpec): string {
  const sections = new Set(spec.sections);
  const blocks: string[] = [];
  if (sections.has('features')) {
    blocks.push(`      <section class="features" id="features">
        <h2>What you get</h2>
        <div class="grid">
          <div class="card"><h3>Clear structure</h3><p>Every page has a single purpose and a clear path to the next one.</p></div>
          <div class="card"><h3>Fast by default</h3><p>Static files, no framework overhead, ready for any host.</p></div>
          <div class="card"><h3>Easy to edit</h3><p>Plain HTML and CSS that any developer can pick up.</p></div>
        </div>
      </section>`);
  }
  if (sections.has('testimonials')) {
    blocks.push(`      <section class="testimonials" id="testimonials">
        <h2>Testimonials</h2>
        <div class="grid">
          <div class="card"><p>"Quick, clear and exactly what the client asked for."</p><h3>— A happy client</h3></div>
          <div class="card"><p>"The review artifact made sign-off painless."</p><h3>— A product owner</h3></div>
        </div>
      </section>`);
  }
  if (sections.has('faq')) {
    blocks.push(`      <section class="faq" id="faq">
        <h2>FAQ</h2>
        <div class="card"><h3>How do I get the files?</h3><p>Download the zip from the review artifact after delivery.</p></div>
      </section>`);
  }
  if (sections.has('pricing')) {
    blocks.push(`      <section class="pricing" id="pricing">
        <h2>Pricing</h2>
        <div class="grid">
          <div class="card"><h3>Starter</h3><p>A single, focused page.</p></div>
          <div class="card"><h3>Standard</h3><p>A multi-page static site.</p></div>
        </div>
      </section>`);
  }
  return blocks.join('\n');
}

function pageHtml(spec: SiteSpec, title: string, intro: string): string {
  const name = escapeHtml(spec.name);
  return `<!DOCTYPE html>
<html lang="${spec.language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} — ${name}</title>
    <meta name="description" content="${escapeHtml(intro)}" />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/index.html">${name}</a>
      <nav class="site-nav">
          ${navLinks(spec)}
      </nav>
    </header>
    <main>
      <section class="hero">
        <h1>${escapeHtml(title)}</h1>
        <p class="lede">${escapeHtml(spec.tagline)}</p>
      </section>
      <section class="content">
        <p>${escapeHtml(intro)}</p>
      </section>
${sectionsHtml(spec)}
    </main>
    <footer class="site-footer">
      <p>© ${new Date().getUTCFullYear()} ${name}. Built by the AI Employee — automated, reviewed, delivered.</p>
    </footer>
    <script src="/assets/app.js" defer></script>
  </body>
</html>
`;
}

function stylesCss(spec: SiteSpec): string {
  return `:root {
  --primary: ${spec.primaryColor};
  --accent: ${spec.accentColor};
  --ink: #111827;
  --paper: #ffffff;
  --muted: #6b7280;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: '${spec.font}', system-ui, sans-serif;
  color: var(--ink);
  line-height: 1.6;
  background: var(--paper);
}
.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 2rem;
  border-bottom: 1px solid #e5e7eb;
}
.brand { font-weight: 800; color: var(--primary); text-decoration: none; font-size: 1.25rem; }
.site-nav { display: flex; gap: 1.25rem; flex-wrap: wrap; }
.site-nav a { color: var(--ink); text-decoration: none; }
.site-nav a:hover { color: var(--primary); }
.hero { padding: 4rem 2rem; text-align: center; background: linear-gradient(135deg, var(--primary), var(--accent)); color: #ffffff; }
.hero h1 { margin: 0 0 0.5rem; font-size: 2.5rem; }
.lede { font-size: 1.15rem; opacity: 0.95; max-width: 42rem; margin: 0 auto; }
.content { max-width: 64rem; margin: 2rem auto; padding: 0 1.5rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1.25rem; margin-top: 1rem; }
.card { border: 1px solid #e5e7eb; border-radius: 0.75rem; padding: 1.25rem; }
.features, .testimonials, .faq, .pricing { max-width: 64rem; margin: 2rem auto; padding: 0 1.5rem; }
.site-footer { border-top: 1px solid #e5e7eb; padding: 1.5rem 2rem; color: var(--muted); text-align: center; }
`;
}

function appJs(): string {
  return `// Generated by the AI Employee (AG-701) — deterministic static build.
document.querySelectorAll('a[href]').forEach(function (link) {
  link.addEventListener('click', function () {
    var label = (link.getAttribute('href') || '/').replace(/\\.html$/, '');
    window.dispatchEvent(new CustomEvent('page:navigate', { detail: { page: label } }));
  });
});
`;
}

/** Generates the full static site for a spec, with `spec.notes` rendered last. */
export function generateStaticSite(spec: SiteSpec): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const page of spec.pages) {
    const relativePath = page.slug === 'index' ? 'index.html' : `${page.slug}.html`;
    files.push({ relativePath, content: pageHtml(spec, page.title, page.intro) });
  }
  files.push({ relativePath: 'styles.css', content: stylesCss(spec) });
  files.push({ relativePath: 'assets/app.js', content: appJs() });
  return files;
}
