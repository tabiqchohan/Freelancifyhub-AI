import { join } from 'node:path';
import { z } from 'zod';

import { ToolCategory, ToolSecurityLevel } from '../ag-004-tool-manager/enums/index.js';
import type { ToolHandler, ToolSpecification } from '../ag-004-tool-manager/types/index.js';
import { ToolValidationError } from '../ag-004-tool-manager/errors/index.js';
import type { EmployeeConfig } from './config.js';
import { EmployeeError, EmployeeErrorCode } from './errors.js';
import { WorkspaceManager } from './workspace.js';
import { buildStaticSite, defaultValidationRequirements, validateBuiltSite } from './build.js';
import { createZip, sha256Hex } from './zip.js';

/**
 * Prompts17 Phase 18 — Employee tools registered on AG-004.
 *
 * The website developer (AG-701) works ONLY through these four tools. Every one
 * re-derives its isolated workspace from the task scoping (`project`/`task` /
 * actor namespace), stays inside `config.EMPLOYEE_WORKSPACE_ROOT`, applies the
 * fail-closed path policy, and enforces a per-task tool-call budget. There is no
 * unrestricted shell, network, exec or filesystem surface exposed anywhere.
 */

export const EMPLOYEE_WRITE_TOOL = 'employee-workspace-write';
export const EMPLOYEE_BUILD_TOOL = 'employee-workspace-build';
export const EMPLOYEE_VALIDATE_TOOL = 'employee-workspace-validate';
export const EMPLOYEE_PACKAGE_TOOL = 'employee-workspace-package';

export interface EmployeeToolsContext {
  readonly config: EmployeeConfig;
  /** Absolute base directory holding `<base>/<project>/<task>` workspaces. */
  readonly workspacesRoot: string;
  /** Per-task tool-call budget check; throws RESOURCE_LIMIT when exhausted. */
  readonly trackToolCall: (taskId: string) => void;
}

function workspaceFor(deps: EmployeeToolsContext, project: string, task: string): WorkspaceManager {
  return new WorkspaceManager(join(deps.workspacesRoot, project, task), deps.config);
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ToolValidationError('Invalid employee tool input', {
      code: 'INVALID_EMPLOYEE_TOOL_INPUT',
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  return parsed.data;
}

const scopedInput = z.object({
  project: z.string().min(1).max(128),
  task: z.string().min(1).max(128),
});
const writeInput = scopedInput.extend({
  path: z.string().min(1).max(255),
  content: z.string().max(1_048_576),
});
const buildInput = scopedInput.extend({
  pages: z
    .array(z.object({ slug: z.string().min(1).max(64) }))
    .min(1)
    .max(30),
});
const validateInput = scopedInput;
const packageInput = scopedInput;

export function createEmployeeToolSpecifications(deps: EmployeeToolsContext): ToolSpecification[] {
  const writeHandler: ToolHandler = {
    name: EMPLOYEE_WRITE_TOOL,
    async invoke(input: unknown) {
      const parsed = parseInput(writeInput, input);
      deps.trackToolCall(parsed.task);
      const workspace = workspaceFor(deps, parsed.project, parsed.task);
      const result = await workspace.write(parsed.path, parsed.content);
      return { bytes: result.bytes, totalBytes: result.totalBytes, fileCount: result.fileCount };
    },
  };

  const buildHandler: ToolHandler = {
    name: EMPLOYEE_BUILD_TOOL,
    async invoke(input: unknown) {
      const parsed = parseInput(buildInput, input);
      deps.trackToolCall(parsed.task);
      const workspace = workspaceFor(deps, parsed.project, parsed.task);
      const output = await buildStaticSite(workspace);
      return {
        entryFile: output.entryFile,
        fileCount: output.fileCount,
        manifest: output.manifest,
      };
    },
  };

  const validateHandler: ToolHandler = {
    name: EMPLOYEE_VALIDATE_TOOL,
    async invoke(input: unknown) {
      const parsed = parseInput(validateInput, input);
      deps.trackToolCall(parsed.task);
      const workspace = workspaceFor(deps, parsed.project, parsed.task);
      const requirements = defaultValidationRequirements(
        deps.config.EMPLOYEE_MAX_FILE_BYTES,
        deps.config.EMPLOYEE_MAX_WORKSPACE_BYTES,
      );
      return (await validateBuiltSite(workspace, requirements)) as unknown;
    },
  };

  const packageHandler: ToolHandler = {
    name: EMPLOYEE_PACKAGE_TOOL,
    async invoke(input: unknown) {
      const parsed = parseInput(packageInput, input);
      deps.trackToolCall(parsed.task);
      const workspace = workspaceFor(deps, parsed.project, parsed.task);

      const distFiles = await workspace.list('dist');
      if (distFiles.length === 0) {
        throw new EmployeeError(
          EmployeeErrorCode.RESOURCE_LIMIT,
          'nothing to package: dist is empty',
        );
      }
      const entries = [];
      for (const file of distFiles) {
        const content = await workspace.read(`dist/${file}`);
        entries.push({ name: `dist/${file}`, content });
      }
      const archive = createZip(entries);
      if (archive.byteLength > deps.config.EMPLOYEE_MAX_ARTIFACT_BYTES) {
        throw new EmployeeError(
          EmployeeErrorCode.RESOURCE_LIMIT,
          'packaged artifact exceeds the configured limit',
          {
            bytes: archive.byteLength,
          },
        );
      }
      const fileName = `${parsed.task}-bundle.zip`;
      const { bytes } = await workspace.write(`artifacts/${fileName}`, archive);
      return {
        fileName,
        sizeBytes: bytes,
        sha256: sha256Hex(archive),
        artifactPath: workspace.resolve(`artifacts/${fileName}`),
        fileEntries: entries.length,
      };
    },
  };

  const policy = {
    timeoutMs: deps.config.EMPLOYEE_TOOL_TIMEOUT_MS,
    maxInputBytes: 2 * 1024 * 1024,
    maxOutputBytes: 512 * 1024,
    retryPolicy: { maxRetries: 0, backoffBaseMs: 50, backoffMaxMs: 500 },
    concurrencyLimit: 8,
    securityLevel: ToolSecurityLevel.Confidential,
  };

  const spec = (
    name: string,
    description: string,
    inputSchema: z.ZodType<unknown>,
    handler: ToolHandler,
  ): ToolSpecification => ({
    name,
    description,
    version: '1.0.0',
    category: ToolCategory.FileSystem,
    inputSchema,
    outputSchema: z.unknown(),
    handler,
    permissions: [],
    securityLevel: ToolSecurityLevel.Confidential,
    executionPolicy: policy,
    metadata: { kind: 'employee-website-developer' },
  });

  return [
    spec(
      EMPLOYEE_WRITE_TOOL,
      'Writes one file inside the AI Employee task workspace (fail-closed path policy applies).',
      writeInput,
      writeHandler,
    ),
    spec(
      EMPLOYEE_BUILD_TOOL,
      'Deterministically builds the workspace source into a dist bundle with a manifest.',
      buildInput,
      buildHandler,
    ),
    spec(
      EMPLOYEE_VALIDATE_TOOL,
      'Validates the built site: required files, internal links, HTML hygiene, size budgets.',
      validateInput,
      validateHandler,
    ),
    spec(
      EMPLOYEE_PACKAGE_TOOL,
      'Packages the built site into the extractable zip review artifact.',
      packageInput,
      packageHandler,
    ),
  ];
}
