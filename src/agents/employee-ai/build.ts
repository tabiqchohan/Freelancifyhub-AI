import { readFile } from 'node:fs/promises';
import type { WorkspaceManager } from './workspace.js';
import type { ValidationIssue, ValidationReport, ValidationRequirements } from './types.js';

/**
 * Prompts17 Phase 18 — Real static build + validation.
 *
 * "Build" is a genuine, deterministic step: source files from the workspace are
 * read, normalized into a `dist/` bundle and combined with a machine-readable
 * `_meta.json` manifest. Validation then checks structure, internal links and
 * HTML hygiene — the same gates a human reviewer would apply. Every helper here
 * is exported so the EMP-FUNC tests can drive them directly.
 */

export const BUILD_DIR = 'dist';

export interface BuildOutput {
  readonly entryFile: string;
  readonly fileCount: number;
  readonly manifest: { readonly build: string; readonly files: ReadonlyArray<string> };
}

export async function readManifest(
  workspace: WorkspaceManager,
  dir: string,
): Promise<{ readonly build: string; readonly files: ReadonlyArray<string> }> {
  const raw = await workspace.read(`${dir}/_meta.json`);
  const parsed = JSON.parse(raw) as { build?: unknown; files?: unknown };
  return {
    build: typeof parsed.build === 'string' ? parsed.build : 'unknown',
    files: Array.isArray(parsed.files)
      ? parsed.files.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

/**
 * Performs the deterministic build. Copies every source file (excluding a
 * previous dist) into `dist/`, records the manifest, and returns build stats.
 * Throws when the entry file is missing (a real build failure).
 */
export async function buildStaticSite(workspace: WorkspaceManager): Promise<BuildOutput> {
  const sourceFiles = (await workspace.list('.')).filter(
    (file) => !file.startsWith(`${BUILD_DIR}/`) && file !== BUILD_DIR,
  );
  if (!sourceFiles.includes('index.html')) {
    throw new Error('build failed: missing required source file index.html');
  }

  for (const file of sourceFiles) {
    const content = await workspace.read(file);
    await workspace.write(`${BUILD_DIR}/${file}`, content);
  }

  const distFiles = (await workspace.list(BUILD_DIR)).sort();
  const pages = distFiles
    .filter((file) => file.endsWith('.html'))
    .map((file) => JSON.stringify(file))
    .join(', ');
  await workspace.write(
    `${BUILD_DIR}/_meta.json`,
    `{\n  "build": "static",\n  "generatedBy": "AG-701",\n  "pages": [${pages}]\n}`,
  );

  return {
    entryFile: `${BUILD_DIR}/index.html`,
    fileCount: distFiles.length + 1,
    manifest: await readManifest(workspace, BUILD_DIR),
  };
}

function linkTarget(raw: string): string {
  const clean = raw.split(/[?#]/)[0];
  if (!clean || clean === '' || clean === '/') return 'index.html';
  if (clean.endsWith('/')) return `${clean}index.html`;
  if (!clean.includes('.')) return `${clean}.html`;
  return clean.replace(/^\/+/, '');
}

/** Extracts internal non-anchor link/src targets from HTML (no scheme refs). */
export function extractInternalLinks(html: string): string[] {
  const targets: string[] = [];
  const hrefPattern = /\shref="([^"]+)"/g;
  const srcPattern = /\ssrc="([^"]+)"/g;
  for (const pattern of [hrefPattern, srcPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const target = match[1] ?? '';
      if (target.startsWith('#') || /^[a-z]+:/i.test(target)) continue;
      targets.push(linkTarget(target));
    }
  }
  return targets;
}

/** Basic HTML hygiene: DOCTYPE, tag balance, no stray/unclosed tags. */
export function validateHtmlHygiene(html: string): string[] {
  const issues: string[] = [];
  const stack: string[] = [];
  const voidElements = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const raw = match[0];
    const name = (match[1] ?? '').toLowerCase();
    if (raw.startsWith('</')) {
      const expected = stack.pop();
      if (expected !== name)
        issues.push(`mismatched </${name}> (expected </${expected ?? 'none'}>)`);
    } else if (!raw.endsWith('/>') && !voidElements.has(name)) {
      stack.push(name);
    }
  }
  if (stack.length > 0) issues.push(`unclosed tags: ${stack.join(', ')}`);
  if (!html.trimStart().toLowerCase().startsWith('<!doctype html'))
    issues.push('missing <!doctype html>');
  return issues;
}

function issue(detail: string, category: ValidationIssue['category']): ValidationIssue {
  const message: Record<ValidationIssue['category'], string> = {
    FILE_MISSING: 'required file is missing',
    FILE_TOO_LARGE: 'file exceeds the configured limit',
    TOTAL_TOO_LARGE: 'workspace exceeds the total size limit',
    BAD_LINK: 'internal link points to a missing target',
    MALFORMED_HTML: 'HTML hygiene check failed',
  };
  return { category, severity: 'error', message: `${message[category]}: ${detail}` };
}

export async function validateBuiltSite(
  workspace: WorkspaceManager,
  requirements: ValidationRequirements,
): Promise<ValidationReport & { readonly fileCount: number; readonly totalBytes: number }> {
  const issues: ValidationIssue[] = [];
  const files = await workspace.list(BUILD_DIR);

  for (const required of requirements.requiredFiles) {
    if (!files.includes(required)) {
      issues.push(issue(required, 'FILE_MISSING'));
    }
  }

  let totalBytes = 0;
  for (const file of files) {
    const size = (await readFile(workspace.resolve(`${BUILD_DIR}/${file}`))).byteLength;
    totalBytes += size;
    if (size > requirements.maxFileBytes) {
      issues.push(issue(file, 'FILE_TOO_LARGE'));
    }
  }
  if (totalBytes > requirements.maxTotalBytes) {
    issues.push(issue(`${totalBytes} bytes`, 'TOTAL_TOO_LARGE'));
  }

  const htmlFiles = files.filter((file) => file.endsWith('.html'));
  for (const htmlFile of htmlFiles) {
    const content = await readFile(workspace.resolve(`${BUILD_DIR}/${htmlFile}`), 'utf8');
    for (const hygieneIssue of validateHtmlHygiene(content)) {
      issues.push(issue(`${htmlFile}: ${hygieneIssue}`, 'MALFORMED_HTML'));
    }
    for (const target of extractInternalLinks(content)) {
      if (!files.includes(target)) {
        issues.push(issue(`${htmlFile} -> ${target}`, 'BAD_LINK'));
      }
    }
  }

  if (!files.includes('_meta.json')) {
    issues.push(issue('_meta.json', 'FILE_MISSING'));
  }

  return {
    structureOk: files.includes('index.html') && files.includes('_meta.json'),
    linksOk: issues.every((entry) => entry.category !== 'BAD_LINK'),
    htmlOk: issues.every((entry) => entry.category !== 'MALFORMED_HTML'),
    artifactsOk: files.includes('_meta.json'),
    passed: issues.length === 0,
    issues,
    fileCount: files.length,
    totalBytes,
  };
}

export function defaultValidationRequirements(
  maxFileBytes: number,
  maxTotalBytes: number,
): ValidationRequirements {
  return {
    requiredFiles: ['index.html', 'styles.css', '_meta.json', 'assets/app.js'],
    maxFileBytes,
    maxTotalBytes,
    assertInternalLinks: true,
    assertNoLargerThanExpected: true,
  };
}
