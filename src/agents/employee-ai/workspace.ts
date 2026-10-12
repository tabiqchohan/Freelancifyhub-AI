import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { EmployeeError, EmployeeErrorCode } from './errors.js';
import type { EmployeeConfig } from './config.js';

/**
 * Prompts17 Phase 18 — Fail-closed workspace.
 *
 * The AI Employee operates ONLY inside `<root>/<projectId>/<taskId>`. Every path
 * that reaches the filesystem goes through {@link WorkspaceManager.resolve}, which
 * refuses: absolute paths, `..` traversal, dotfiles, drive letters, backslashes,
 * NUL bytes and symlink escapes (real-path assertion). No defensive Deny-list is
 * ever consulted — the allow-list IS the workspace root.
 */

const MAX_RELATIVE_LENGTH = 255;

function assertWithinRoot(rootAbs: string, candidate: string, label: string): void {
  const rel = relative(rootAbs, candidate);
  if (rel === '' || rel === '.') return;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new EmployeeError(
      EmployeeErrorCode.WORKSPACE_ESCAPE,
      `path escapes the ${label} workspace`,
      { candidate },
    );
  }
}

export class WorkspaceManager {
  private readonly root: string;

  constructor(
    rootAbs: string,
    private readonly config: EmployeeConfig,
  ) {
    this.root = rootAbs;
  }

  get rootPath(): string {
    return this.root;
  }

  /** Safe relative-path validation. Throws WORKSPACE_ESCAPE on anything unsafe. */
  resolve(relativePath: string): string {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
      throw new EmployeeError(EmployeeErrorCode.WORKSPACE_ESCAPE, 'empty workspace path');
    }
    if (relativePath.length > MAX_RELATIVE_LENGTH) {
      throw new EmployeeError(EmployeeErrorCode.WORKSPACE_ESCAPE, 'workspace path too long');
    }
    if (relativePath.includes('\0')) {
      throw new EmployeeError(EmployeeErrorCode.WORKSPACE_ESCAPE, 'NUL byte in workspace path');
    }
    if (relativePath.includes('\\')) {
      throw new EmployeeError(
        EmployeeErrorCode.WORKSPACE_ESCAPE,
        'backslashes are not allowed in workspace paths',
      );
    }
    if (isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
      throw new EmployeeError(
        EmployeeErrorCode.WORKSPACE_ESCAPE,
        'absolute workspace paths are not allowed',
        { relativePath },
      );
    }

    const segments = relativePath.split('/');
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new EmployeeError(
        EmployeeErrorCode.WORKSPACE_ESCAPE,
        'traversal or empty segments are not allowed',
        { relativePath },
      );
    }
    if (segments.some((segment) => segment === 'node_modules')) {
      throw new EmployeeError(
        EmployeeErrorCode.WORKSPACE_ESCAPE,
        'dependency directories are not allowed',
        { relativePath },
      );
    }
    if (segments.some((segment) => segment.startsWith('.'))) {
      throw new EmployeeError(EmployeeErrorCode.WORKSPACE_ESCAPE, 'dot-paths are not allowed', {
        relativePath,
      });
    }

    const joined = join(this.root, ...segments);
    assertWithinRoot(this.root, normalize(joined), 'employee');
    return joined;
  }

  /** Prevents symlink escapes: every existing ancestor's real path stays in-root. */
  private async assertNoSymlinkEscape(candidateAbs: string): Promise<void> {
    let probe = candidateAbs;
    while (true) {
      try {
        const real = await realpath(probe);
        assertWithinRoot(this.root, real, 'employee');
        break;
      } catch (error) {
        if (error instanceof EmployeeError) throw error;
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
  }

  /** Creates root, then normalizes and asserts the requested path. */
  private async resolveEnsureDir(relativePath: string): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const abs = this.resolve(relativePath);
    await mkdir(dirname(abs), { recursive: true });
    return abs;
  }

  private async currentSize(): Promise<{
    readonly totalBytes: number;
    readonly fileCount: number;
  }> {
    let totalBytes = 0;
    let fileCount = 0;
    async function walk(current: string): Promise<void> {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          fileCount += 1;
          totalBytes += (await stat(full)).size;
        }
      }
    }
    try {
      await walk(this.root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    return { totalBytes, fileCount };
  }

  private async enforceBudgets(): Promise<{
    readonly totalBytes: number;
    readonly fileCount: number;
  }> {
    const { totalBytes, fileCount } = await this.currentSize();
    if (fileCount > this.config.EMPLOYEE_MAX_FILE_COUNT) {
      throw new EmployeeError(
        EmployeeErrorCode.RESOURCE_LIMIT,
        'workspace file-count limit exceeded',
        { fileCount },
      );
    }
    if (totalBytes > this.config.EMPLOYEE_MAX_WORKSPACE_BYTES) {
      throw new EmployeeError(EmployeeErrorCode.RESOURCE_LIMIT, 'workspace size limit exceeded', {
        totalBytes,
      });
    }
    return { totalBytes, fileCount };
  }

  async write(
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<{ readonly bytes: number; readonly totalBytes: number; readonly fileCount: number }> {
    const abs = await this.resolveEnsureDir(relativePath);
    await this.assertNoSymlinkEscape(dirname(abs));
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    if (data.byteLength > this.config.EMPLOYEE_MAX_FILE_BYTES) {
      throw new EmployeeError(EmployeeErrorCode.RESOURCE_LIMIT, 'single-file size limit exceeded', {
        path: relativePath,
        bytes: data.byteLength,
      });
    }
    await writeFile(abs, data, { flag: 'w' });
    const { totalBytes, fileCount } = await this.enforceBudgets();
    return { bytes: data.byteLength, totalBytes, fileCount };
  }

  async read(relativePath: string): Promise<string> {
    const abs = this.resolve(relativePath);
    await this.assertNoSymlinkEscape(dirname(abs));
    return readFile(abs, 'utf8');
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.read(relativePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(relativeDir = '.'): Promise<string[]> {
    const isRoot = relativeDir === '.' || relativeDir === '';
    const abs = isRoot ? this.root : this.resolve(relativeDir);
    const files: string[] = [];
    async function walk(current: string, prefix: string): Promise<void> {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full, rel);
        } else if (entry.isFile()) {
          files.push(rel);
        }
      }
    }
    await walk(abs, '');
    return files.sort();
  }

  /** Wipes this task's workspace. Only ever reaches its own root. */
  async reset(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  /** Tears down the whole workspace on finish. */
  async destroy(): Promise<void> {
    await rm(resolve(this.root), { recursive: true, force: true });
  }
}
