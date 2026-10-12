import { EmployeeError, EmployeeErrorCode } from './errors.js';
import { EmployeeScopeTier } from './types.js';
import type { SiteSpec } from './types.js';

/**
 * Prompts17 Phase 18 — Requirements extractor.
 *
 * Produces a complete, executable {@link SiteSpec} from the free-text client
 * request WITHOUT an LLM call: keyword-anchored, deterministic (identical input
 * yields identical spec), and bounded. No user text is ever executed or echoed
 * back unbound; all strings are derived locally and sanitized.
 */

const PAGE_KEYWORDS: ReadonlyArray<{
  readonly keyword: string;
  readonly page: string;
  readonly title: string;
  readonly intro: string;
}> = [
  {
    keyword: 'about',
    page: 'about',
    title: 'About Us',
    intro: 'The story behind the work and the people who make it happen.',
  },
  {
    keyword: 'service',
    page: 'services',
    title: 'Services',
    intro: 'What we offer, clearly and honestly.',
  },
  {
    keyword: 'portfolio',
    page: 'portfolio',
    title: 'Portfolio',
    intro: 'Selected work that shows what we can deliver.',
  },
  {
    keyword: 'product',
    page: 'products',
    title: 'Products',
    intro: 'Everything we ship and support.',
  },
  { keyword: 'blog', page: 'blog', title: 'Blog', intro: 'Notes, guides and updates.' },
  { keyword: 'gallery', page: 'gallery', title: 'Gallery', intro: 'A visual tour of recent work.' },
  { keyword: 'price', page: 'pricing', title: 'Pricing', intro: 'Simple, upfront pricing.' },
  { keyword: 'team', page: 'team', title: 'Our Team', intro: 'Meet the team behind the brand.' },
  { keyword: 'faq', page: 'faq', title: 'FAQ', intro: 'Answers to common questions.' },
  {
    keyword: 'contact',
    page: 'contact',
    title: 'Contact',
    intro: 'Get in touch — we usually reply within one working day.',
  },
];

const SECTION_KEYWORDS: ReadonlyArray<{ readonly keyword: string; readonly section: string }> = [
  { keyword: 'testimonial', section: 'testimonials' },
  { keyword: 'review', section: 'testimonials' },
  { keyword: 'features', section: 'features' },
  { keyword: 'what we offer', section: 'features' },
  { keyword: 'pricing', section: 'pricing' },
  { keyword: 'gallery', section: 'gallery' },
  { keyword: 'blog', section: 'blog-posts' },
  { keyword: 'faq', section: 'faq' },
  { keyword: 'team', section: 'team' },
];

const PALETTES: ReadonlyArray<{ readonly primary: string; readonly accent: string }> = [
  { primary: '#1a73e8', accent: '#e8711a' },
  { primary: '#0f766e', accent: '#f59e0b' },
  { primary: '#4338ca', accent: '#ec4899' },
  { primary: '#7c3aed', accent: '#22d3ee' },
  { primary: '#b91c1c', accent: '#fbbf24' },
  { primary: '#065f46', accent: '#fb923c' },
];

const FONTS: ReadonlyArray<string> = [
  'Inter',
  'Source Sans 3',
  'Poppins',
  'Roboto',
  'Work Sans',
  'Lato',
];

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'for',
  'of',
  'to',
  'and',
  'my',
  'our',
  'we',
  'us',
  'i',
  'want',
  'need',
  'build',
  'create',
  'make',
  'me',
  'website',
  'site',
  'web',
  'page',
  'landing',
  'static',
  'with',
  'using',
  'please',
  'hi',
  'hello',
]);

function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'page';
}

function deriveName(text: string): string {
  const lower = text.toLowerCase();
  const patterns = [
    /for ([a-z0-9 &.'-]+?)(?: website| site| web| the|,|\.|$)/,
    /a ([a-z0-9 &.'-]+?) website/,
    /brand ([a-z0-9 &.'-]+)/,
  ];
  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim().replace(/\s+/g, ' ').slice(0, 40);
      if (name.length > 0) return name;
    }
  }
  const words = lower
    .split(/\s+/)
    .filter((word) => !STOP_WORDS.has(word) && /^[a-z0-9.'-]+$/.test(word));
  if (words.length > 0) return words.slice(0, 3).join(' ');
  return 'Your Brand';
}

function deriveNamedPages(text: string): SiteSpec['pages'] {
  const lower = text.toLowerCase();
  const pages = PAGE_KEYWORDS.filter((entry) => lower.includes(entry.keyword)).map((entry) => ({
    slug: entry.page,
    title: entry.title,
    intro: entry.intro,
  }));
  if (!pages.some((page) => page.slug === 'index')) {
    const name = deriveName(text);
    pages.unshift({ slug: 'index', title: name, intro: `${name} — welcome.` });
  }
  if (!pages.some((page) => page.slug === 'contact')) {
    const contact = PAGE_KEYWORDS.find((entry) => entry.keyword === 'contact');
    pages.push({
      slug: 'contact',
      title: 'Contact',
      intro: contact?.intro ?? 'Get in touch — we usually reply within one working day.',
    });
  }
  return pages;
}

function deriveSections(text: string): string[] {
  const lower = text.toLowerCase();
  const sections = ['hero', 'features', 'contact'];
  for (const entry of SECTION_KEYWORDS) {
    if (lower.includes(entry.keyword) && !sections.includes(entry.section)) {
      sections.push(entry.section);
    }
  }
  if (lower.includes('portfolio') && !sections.includes('portfolio')) sections.push('portfolio');
  return sections;
}

/** Deterministic requirements extraction into a bounded, executable spec. */
export function extractRequirements(requestText: string): SiteSpec {
  const trimmed = requestText.trim();
  if (trimmed.length === 0) {
    throw new EmployeeError(
      EmployeeErrorCode.REQUIREMENTS_FAILED,
      'no request text to derive requirements from',
    );
  }

  const hash = stableHash(trimmed);
  const palette = PALETTES[hash % PALETTES.length] ?? PALETTES[0]!;
  const pages = deriveNamedPages(trimmed);
  const sections = deriveSections(trimmed);
  const name = deriveName(trimmed);
  const recognized = sections.filter(
    (section) => section !== 'hero' && section !== 'features' && section !== 'contact',
  );

  return {
    name,
    tagline: `${name} — clear, modern, and made to be useful.`,
    pages: pages.map((page) => ({
      slug: slugify(page.slug),
      title: page.title,
      intro: page.intro,
    })),
    sections,
    primaryColor: palette.primary,
    accentColor: palette.accent,
    font: FONTS[hash % FONTS.length] ?? FONTS[0]!,
    language: 'en',
    ...(recognized.length > 0 ? { notes: recognized } : {}),
  };
}

/**
 * Builds the execution plan for a validated static-site spec. Small, honest,
 * tool-backed steps the executor will actually perform.
 */
export function buildExecutionPlan(spec: SiteSpec) {
  return {
    objective: `Build the "${spec.name}" static website (${spec.pages.length} pages) inside the isolated workspace.`,
    scopeTier: EmployeeScopeTier.STATIC_SITE,
    steps: [
      {
        toolName: 'employee-workspace-write',
        step: 'ASSEMBLE' as const,
        detail: 'write HTML/CSS/JS files for all pages and shared assets',
      },
      {
        toolName: 'employee-workspace-build',
        step: 'BUILD' as const,
        detail: 'compile workspace into a deterministic dist bundle with a manifest',
      },
      {
        toolName: 'employee-workspace-validate',
        step: 'VALIDATE' as const,
        detail: 'structural, link and HTML-hygiene validation of dist',
      },
      {
        toolName: 'employee-workspace-package',
        step: 'PACKAGE' as const,
        detail: 'package dist into the review artifact (zip)',
      },
    ],
    estimatedFiles: spec.pages.length * 2 + 3,
  };
}
