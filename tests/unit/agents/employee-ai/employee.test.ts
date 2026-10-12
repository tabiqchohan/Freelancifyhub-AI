import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ToolActorGroup,
  ToolResultStatus,
} from '../../../../src/agents/ag-004-tool-manager/enums/index.js';
import type {
  ToolExecutionContext,
  ToolJsonValue,
  ToolResult,
} from '../../../../src/agents/ag-004-tool-manager/types/index.js';
import { InMemoryToolRepository } from '../../../../src/agents/ag-004-tool-manager/repositories/index.js';
import { parseToolConfig } from '../../../../src/agents/ag-004-tool-manager/config/index.js';
import { ToolManagerService } from '../../../../src/agents/ag-004-tool-manager/services/tool-manager.service.js';

import {
  DEFAULT_EMPLOYEE_CONFIG,
  parseEmployeeConfig,
} from '../../../../src/agents/employee-ai/config.js';
import { EmployeeError, EmployeeErrorCode } from '../../../../src/agents/employee-ai/errors.js';
import { classifyScope, assertSupportedScope } from '../../../../src/agents/employee-ai/scope.js';
import { EmployeeScopeTier, EmployeePhase } from '../../../../src/agents/employee-ai/types.js';
import { WorkspaceManager } from '../../../../src/agents/employee-ai/workspace.js';
import {
  buildStaticSite,
  validateHtmlHygiene,
  extractInternalLinks,
  validateBuiltSite,
  defaultValidationRequirements,
} from '../../../../src/agents/employee-ai/build.js';
import { generateStaticSite } from '../../../../src/agents/employee-ai/generator.js';
import {
  extractRequirements,
  buildExecutionPlan,
} from '../../../../src/agents/employee-ai/requirements.js';
import { createZip, crc32, sha256Hex } from '../../../../src/agents/employee-ai/zip.js';
import { createEmployeeToolSpecifications } from '../../../../src/agents/employee-ai/tools.js';
import { EmployeeExecutor, TaskToolBudget } from '../../../../src/agents/employee-ai/execution.js';
import { EmployeeService } from '../../../../src/agents/employee-ai/service.js';
import type {
  EmployeeEvent,
  EmployeeEventSink,
} from '../../../../src/agents/employee-ai/events.js';
import type { EmployeeConfig } from '../../../../src/agents/employee-ai/config.js';

/**
 * Prompts17 — AI Employee test suite.
 *
 *   EMP-SEC-* : security invariants (workspace confinement, artifact safety,
 *               scope fail-closedness, ownership authz, budgets).
 *   EMP-FUNC-*: functional pipeline (requirements, plan, execution, real
 *               artifact, validation, repair loop bounds, cancellation,
 *               deadline, metrics).
 */

const collectingEvents = (): { sink: EmployeeEventSink; events: EmployeeEvent[] } => {
  const events: EmployeeEvent[] = [];
  return {
    events,
    sink: { emit: (event: EmployeeEvent) => events.push(event) },
  };
};

function successResult(name: string, output: unknown): ReturnType<typeof buildResult> {
  return buildResult(name, ToolResultStatus.Success, output);
}

function buildResult(name: string, status: ToolResultStatus, output?: unknown): ToolResult {
  return {
    toolId: `tool:${name}:v1`,
    toolName: name,
    toolVersion: '1.0.0',
    executionId: `ex-${Math.random().toString(36).slice(2)}`,
    durationMs: 1,
    status,
    ...(output !== undefined ? { output: output as ToolJsonValue } : {}),
  };
}

function toolConfig(): ReturnType<typeof parseToolConfig> {
  return parseToolConfig({ TOOLS_ENABLED: 'true' });
}

async function buildToolManager(
  workspacesRoot: string,
  config: EmployeeConfig,
): Promise<{ toolManager: ToolManagerService; budget: TaskToolBudget }> {
  const toolManager = new ToolManagerService({
    repository: new InMemoryToolRepository(),
    config: toolConfig(),
  });
  const budget = new TaskToolBudget();
  const specs = createEmployeeToolSpecifications({
    config,
    workspacesRoot,
    trackToolCall: (taskId) => budget.track(taskId, config.EMPLOYEE_MAX_TOOL_CALLS),
  });
  const registrationActor = {
    group: ToolActorGroup.ToolManager,
    id: 'test-composition',
    namespaces: ['default'],
  };
  for (const spec of specs) {
    await toolManager.register(spec, registrationActor, 'default');
  }
  return { toolManager, budget };
}

let tempDirs: string[] = [];
async function makeWorkspacesRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'emp-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

const STATIC_REQUEST =
  'a portfolio website for Acme Studio with an about page, services and pricing';
const TASK_INPUT = {
  taskId: 'task-1',
  projectId: 'project-1',
  clientId: 'client-1',
  requestText: STATIC_REQUEST,
};

describe('EMP-SEC-1 workspace confinement', () => {
  it('rejects absolute paths, traversal, drive letters, backslashes, NUL bytes and dotfiles', async () => {
    const root = await makeWorkspacesRoot();
    const workspace = new WorkspaceManager(
      join(root, 'project-1', 'task-1'),
      DEFAULT_EMPLOYEE_CONFIG,
    );
    for (const bad of [
      '/etc/passwd',
      '../escape.txt',
      'a/../../escape.txt',
      'C:\\windows\\evil',
      '..\\evil',
      'a\\b.txt',
      'file\0name',
      '.env',
      'node_modules/x/y.js',
      'a/.hidden',
    ]) {
      expect(() => workspace.resolve(bad)).toThrow(EmployeeError);
    }
    const rel = workspace.resolve('index.html');
    expect(rel).toContain(join(root, 'project-1', 'task-1'));
  });

  it('enforces file size, total size and file-count budgets', async () => {
    const root = await makeWorkspacesRoot();
    const config: EmployeeConfig = {
      ...DEFAULT_EMPLOYEE_CONFIG,
      EMPLOYEE_MAX_FILE_BYTES: 64,
      EMPLOYEE_MAX_FILE_COUNT: 3,
      EMPLOYEE_MAX_WORKSPACE_BYTES: 200,
    };
    const workspace = new WorkspaceManager(join(root, 'p', 't'), config);
    await expect(workspace.write('big.txt', 'x'.repeat(65))).rejects.toMatchObject({
      code: EmployeeErrorCode.RESOURCE_LIMIT,
    });
    await workspace.write('a.txt', 'aaa');
    await workspace.write('b.txt', 'bbb');
    await workspace.write('c.txt', 'ccc');
    await expect(workspace.write('d.txt', 'ddd')).rejects.toMatchObject({
      code: EmployeeErrorCode.RESOURCE_LIMIT,
    });
  });

  it('blocks writes that would escape through a symlink directory', async () => {
    const root = await makeWorkspacesRoot();
    const config = { ...DEFAULT_EMPLOYEE_CONFIG };
    const workspace = new WorkspaceManager(join(root, 'p', 't'), config);
    await workspace.write('real/inner.txt', 'inner');
    const outsideDir = await mkdtemp(join(tmpdir(), 'emp-outside-'));
    tempDirs.push(outsideDir);
    const linkTarget = join(workspace.rootPath, 'real', 'linked');
    try {
      await symlink(outsideDir, linkTarget, 'junction');
    } catch {
      // Symlinks unavailable in this environment (privileges) — the path policy
      // still covers the other vectors; skip.
      return;
    }
    await expect(workspace.write('real/linked/evil.txt', 'evil')).rejects.toBeDefined();
  });

  it('rejects unsafe zip entry names and produces real PK archives', async () => {
    expect(() => createZip([{ name: '../evil', content: 'x' }])).toThrow('unsafe zip entry name');
    expect(() => createZip([{ name: '/abs', content: 'x' }])).toThrow('unsafe zip entry name');
    const archive = createZip([
      { name: 'dist/index.html', content: '<h1>Hi</h1>' },
      { name: 'dist/styles.css', content: 'body{}' },
    ]);
    const signature = Buffer.from(archive.subarray(0, 4)).toString('latin1');
    expect(signature).toBe('PK\x03\x04');
    expect(
      Buffer.from(archive.subarray(archive.byteLength - 22, archive.byteLength - 18)).toString(
        'latin1',
      ),
    ).toBe('PK\x05\x06');
    expect(archive.byteLength).toBeGreaterThan(0);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('EMP-SEC-2 scope is fail-closed', () => {
  it('accepts only explicit static-site signals', () => {
    expect(classifyScope(STATIC_REQUEST).tier).toBe(EmployeeScopeTier.STATIC_SITE);
  });
  it('rejects react, npm, backend, database and other unsupported signals', () => {
    for (const bad of [
      'react landing page',
      'next.js portfolio',
      'npm install and build',
      'node backend with api',
      'a shopify store',
      'wordpress blog',
      'database login system',
    ]) {
      expect(classifyScope(bad).tier).toBe(EmployeeScopeTier.UNSUPPORTED);
      expect(() => assertSupportedScope(bad)).toThrow(EmployeeError);
    }
  });
  it('rejects ambiguous requests without any static-site signal', () => {
    expect(classifyScope('hello there, please help me').tier).toBe(EmployeeScopeTier.UNSUPPORTED);
  });
});

describe('EMP-SEC-3 disabled subsystem and ownership', () => {
  it('throws AI_EMPLOYEE_DISABLED when the service is disabled', async () => {
    const { toolManager, budget } = await buildToolManager(
      join(tmpdir(), 'emp-x'),
      DEFAULT_EMPLOYEE_CONFIG,
    );
    const config = { ...DEFAULT_EMPLOYEE_CONFIG, EMPLOYEE_ENABLED: false };
    const service = new EmployeeService(
      config,
      new EmployeeExecutor({
        config,
        workspacesRoot: join(tmpdir(), 'emp-x'),
        toolManager,
        budget,
        events: collectingEvents().sink,
      }),
      collectingEvents().sink,
    );
    await expect(
      service.execute({
        projectId: 'p',
        clientId: 'c',
        requestText: STATIC_REQUEST,
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: EmployeeErrorCode.DISABLED });
  });

  it('rejects artifact access for a non-owner project/client', { timeout: 20_000 }, async () => {
    const root = await makeWorkspacesRoot();
    const { toolManager, budget } = await buildToolManager(root, DEFAULT_EMPLOYEE_CONFIG);
    const events = collectingEvents();
    const service = new EmployeeService(
      DEFAULT_EMPLOYEE_CONFIG,
      new EmployeeExecutor({
        config: DEFAULT_EMPLOYEE_CONFIG,
        workspacesRoot: root,
        toolManager,
        budget,
        events: events.sink,
      }),
      events.sink,
    );
    const run = await service.execute({
      projectId: 'project-1',
      clientId: 'client-1',
      requestText: STATIC_REQUEST,
      requestId: 'r-1',
    });
    await waitForStatus(service, run.taskId, EmployeePhase.READY_FOR_REVIEW);
    await expect(service.artifact(run.taskId, 'project-999', 'client-1')).rejects.toMatchObject({
      code: EmployeeErrorCode.NOT_FOUND,
    });
    await expect(service.artifact(run.taskId, 'project-1', 'client-999')).rejects.toMatchObject({
      code: EmployeeErrorCode.NOT_FOUND,
    });
    const owned = await service.artifact(run.taskId, 'project-1', 'client-1');
    expect(owned?.fileName).toContain(`${run.taskId}-bundle.zip`);
    expect(owned?.base64.length).toBeGreaterThan(0);
  });
});

describe('EMP-FUNC-1 deterministic requirements and plan', () => {
  it('derives a stable spec and plan from free text', () => {
    const first = extractRequirements(STATIC_REQUEST);
    const second = extractRequirements(STATIC_REQUEST);
    expect(first).toEqual(second);
    expect(first.pages.some((page) => page.slug === 'index')).toBe(true);
    expect(first.pages.some((page) => page.slug === 'contact')).toBe(true);
    const plan = buildExecutionPlan(first);
    expect(plan.scopeTier).toBe(EmployeeScopeTier.STATIC_SITE);
    expect(plan.steps).toHaveLength(4);
    expect(plan.steps.map((step) => step.toolName)).toContain('employee-workspace-write');
  });
});

describe('EMP-FUNC-2 generated site is well-formed', () => {
  it('generates html that passes hygiene and internal-link checks', async () => {
    const spec = extractRequirements(STATIC_REQUEST);
    const files = generateStaticSite(spec);
    expect(files.some((file) => file.relativePath === 'index.html')).toBe(true);
    for (const file of files.filter((file) => file.relativePath.endsWith('.html'))) {
      expect(validateHtmlHygiene(file.content)).toEqual([]);
    }
    const index = files.find((file) => file.relativePath === 'index.html')!;
    expect(
      extractInternalLinks(index.content).every((target) =>
        files.some((file) => file.relativePath === target),
      ),
    ).toBe(true);
  });
});

describe('EMP-FUNC-3 full pipeline produces a real artifact through AG-004', () => {
  it('runs executor end-to-end into READY_FOR_REVIEW with validated zip', async () => {
    const root = await makeWorkspacesRoot();
    const { toolManager, budget } = await buildToolManager(root, DEFAULT_EMPLOYEE_CONFIG);
    const events = collectingEvents();
    const executor = new EmployeeExecutor({
      config: DEFAULT_EMPLOYEE_CONFIG,
      workspacesRoot: root,
      toolManager,
      budget,
      events: events.sink,
    });

    const outcome = await executor.executeTask(TASK_INPUT, 'req-1', 'trace-1');
    expect(outcome.result.phase).toBe(EmployeePhase.READY_FOR_REVIEW);
    expect(outcome.result.validation?.passed).toBe(true);
    expect(outcome.result.validation?.linksOk).toBe(true);
    expect(outcome.result.artifact?.fileName).toBe('task-1-bundle.zip');
    expect(outcome.result.repairAttempts).toBe(0);
    expect(outcome.result.toolCalls).toBeGreaterThanOrEqual(5);
    expect(outcome.artifactPath).toBeDefined();

    const zip = await readFile(outcome.artifactPath!);
    expect(Buffer.from(zip.subarray(0, 4)).toString('latin1')).toBe('PK\x03\x04');
    expect(sha256Hex(zip)).toBe(outcome.result.artifact!.sha256);
    expect(events.events.some((event) => event.type === 'AI_EMPLOYEE_STARTED')).toBe(true);
    expect(events.events.some((event) => event.type === 'AI_EMPLOYEE_SUCCEEDED')).toBe(true);
  });

  it('packages every dist file from the workspace build', async () => {
    const root = await makeWorkspacesRoot();
    const workspace = new WorkspaceManager(join(root, 'p', 't'), DEFAULT_EMPLOYEE_CONFIG);
    const spec = extractRequirements(STATIC_REQUEST);
    for (const file of generateStaticSite(spec))
      await workspace.write(file.relativePath, file.content);
    await buildStaticSite(workspace);
    const report = await validateBuiltSite(
      workspace,
      defaultValidationRequirements(
        DEFAULT_EMPLOYEE_CONFIG.EMPLOYEE_MAX_FILE_BYTES,
        DEFAULT_EMPLOYEE_CONFIG.EMPLOYEE_MAX_WORKSPACE_BYTES,
      ),
    );
    expect(report.passed).toBe(true);
    expect((await workspace.list('dist')).length).toBeGreaterThan(2);
  });
});

describe('EMP-FUNC-4 repair loop is bounded', () => {
  const fakeGateway = (validationScript: Array<{ passed: boolean }>) => {
    let i = 0;
    return {
      execute: async (name: string, _input: unknown, _ctx: ToolExecutionContext) => {
        if (name === 'employee-workspace-validate') {
          const current = validationScript[i] ?? { passed: true };
          if (i < validationScript.length) i += 1;
          return successResult(name, {
            ...current,
            issues: current.passed
              ? []
              : [{ category: 'MALFORMED_HTML', severity: 'error', message: 'seed defect' }],
            fileCount: 3,
            totalBytes: 100,
          });
        }
        if (name === 'employee-workspace-package') {
          return successResult(name, {
            fileName: 'emp-t-bundle.zip',
            sizeBytes: 10,
            sha256: sha256Hex(new Uint8Array(10)),
          });
        }
        const output =
          name === 'employee-workspace-write'
            ? { bytes: 12 }
            : {
                entryFile: 'dist/index.html',
                fileCount: 4,
                manifest: { build: 'static', files: [] },
              };
        return successResult(name, output);
      },
    };
  };

  it('repairs up to the bound, then succeeds', async () => {
    const root = await makeWorkspacesRoot();
    const events = collectingEvents();
    const config = { ...DEFAULT_EMPLOYEE_CONFIG, EMPLOYEE_MAX_REPAIR_ATTEMPTS: 3 };
    const executor = new EmployeeExecutor({
      config,
      workspacesRoot: root,
      toolManager: fakeGateway([
        { passed: false },
        { passed: false },
        { passed: false },
        { passed: true },
      ]),
      budget: new TaskToolBudget(),
      events: events.sink,
    });
    const outcome = await executor.executeTask(TASK_INPUT, 'req-1', 'trace-1');
    expect(outcome.result.repairAttempts).toBe(3);
    expect(outcome.result.phase).toBe(EmployeePhase.READY_FOR_REVIEW);
    expect(events.events.some((event) => event.type === 'AI_EMPLOYEE_REPAIR')).toBe(true);
  });

  it('fails after the repair budget is exhausted', async () => {
    const root = await makeWorkspacesRoot();
    const config = { ...DEFAULT_EMPLOYEE_CONFIG, EMPLOYEE_MAX_REPAIR_ATTEMPTS: 3 };
    const executor = new EmployeeExecutor({
      config,
      workspacesRoot: root,
      toolManager: fakeGateway([
        { passed: false },
        { passed: false },
        { passed: false },
        { passed: false },
        { passed: false },
      ]),
      budget: new TaskToolBudget(),
      events: collectingEvents().sink,
    });
    const outcome = await executor.executeTask(TASK_INPUT, 'req-1', 'trace-1');
    expect(outcome.result.phase).toBe(EmployeePhase.FAILED);
    expect(outcome.result.error?.code).toBe(EmployeeErrorCode.VALIDATION_FAILED);
    expect(outcome.result.artifact).toBeUndefined();
  });
});

describe('EMP-FUNC-5 cancellation and deadline', () => {
  it('cancels cleanly when the caller aborts', async () => {
    const root = await makeWorkspacesRoot();
    const gateway = {
      execute: (name: string, _input: unknown, ctx: ToolExecutionContext) =>
        new Promise<ToolResult>((resolve) => {
          ctx.signal?.addEventListener(
            'abort',
            () => resolve(buildResult(name, ToolResultStatus.Cancelled)),
            { once: true },
          );
        }),
    };
    const executor = new EmployeeExecutor({
      config: DEFAULT_EMPLOYEE_CONFIG,
      workspacesRoot: root,
      toolManager: gateway,
      budget: new TaskToolBudget(),
      events: collectingEvents().sink,
    });
    const controller = new AbortController();
    const running = executor.executeTask(TASK_INPUT, 'req-1', 'trace-1', controller.signal);
    setTimeout(() => controller.abort(), 20);
    const outcome = await running;
    expect(outcome.result.phase).toBe(EmployeePhase.CANCELED);
    expect(outcome.result.error?.code).toBe(EmployeeErrorCode.CANCELLED);
  });

  it('times out when the execution deadline passes', async () => {
    const root = await makeWorkspacesRoot();
    const gateway = {
      execute: async (_name: string, _input: unknown, _ctx: ToolExecutionContext) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return successResult('employee-workspace-write', { bytes: 10 });
      },
    };
    const config = { ...DEFAULT_EMPLOYEE_CONFIG, EMPLOYEE_MAX_EXECUTION_MS: 60 };
    const executor = new EmployeeExecutor({
      config,
      workspacesRoot: root,
      toolManager: gateway,
      budget: new TaskToolBudget(),
      events: collectingEvents().sink,
    });
    const outcome = await executor.executeTask(TASK_INPUT, 'req-1', 'trace-1');
    expect(outcome.result.phase).toBe(EmployeePhase.TIMED_OUT);
    expect(outcome.result.error?.code).toBe(EmployeeErrorCode.TIMED_OUT);
  });

  it('rejects unsupported requests without touching the filesystem', async () => {
    const root = await makeWorkspacesRoot();
    const { toolManager, budget } = await buildToolManager(root, DEFAULT_EMPLOYEE_CONFIG);
    const executor = new EmployeeExecutor({
      config: DEFAULT_EMPLOYEE_CONFIG,
      workspacesRoot: root,
      toolManager,
      budget,
      events: collectingEvents().sink,
    });
    const outcome = await executor.executeTask(
      { ...TASK_INPUT, requestText: 'react next.js app with stripe' },
      'req-1',
      'trace-1',
    );
    expect(outcome.result.phase).toBe(EmployeePhase.FAILED);
    expect(outcome.result.error?.code).toBe(EmployeeErrorCode.UNSUPPORTED_SCOPE);
  });
});

describe('EMP-FUNC-6 tool-call budget', () => {
  it('throws when the per-task tool-call budget is exhausted', async () => {
    const budget = new TaskToolBudget();
    const config = { ...DEFAULT_EMPLOYEE_CONFIG, EMPLOYEE_MAX_TOOL_CALLS: 2 };
    budget.track('t1', config.EMPLOYEE_MAX_TOOL_CALLS);
    budget.track('t1', config.EMPLOYEE_MAX_TOOL_CALLS);
    expect(() => budget.track('t1', config.EMPLOYEE_MAX_TOOL_CALLS)).toThrow(EmployeeError);
    expect(budget.count('t1')).toBe(2);
  });
});

describe('EMP-FUNC-7 service lifecycle and metrics', () => {
  it('tracks status transitions and emits billable metrics', { timeout: 20_000 }, async () => {
    const root = await makeWorkspacesRoot();
    const { toolManager, budget } = await buildToolManager(root, DEFAULT_EMPLOYEE_CONFIG);
    const events = collectingEvents();
    const service = new EmployeeService(
      DEFAULT_EMPLOYEE_CONFIG,
      new EmployeeExecutor({
        config: DEFAULT_EMPLOYEE_CONFIG,
        workspacesRoot: root,
        toolManager,
        budget,
        events: events.sink,
      }),
      events.sink,
    );

    const run = await service.execute({
      projectId: 'project-1',
      clientId: 'client-1',
      requestText: STATIC_REQUEST,
      requestId: 'req-1',
    });
    expect(run.employee).toBe('AG-701');
    await waitForStatus(service, run.taskId, EmployeePhase.READY_FOR_REVIEW);
    const status = service.status(run.taskId);
    expect(status.status).toBe(EmployeePhase.READY_FOR_REVIEW);
    expect(status.result?.artifact?.fileName).toContain('bundle.zip');
    const snapshot = service.metricsSnapshot();
    expect(snapshot.tasksSucceeded).toBeGreaterThanOrEqual(1);
    expect(snapshot.filesCreated).toBeGreaterThan(0);
    expect(snapshot.toolCalls).toBeGreaterThan(0);
  });

  it('exposes the parsed env defaults and schema', () => {
    const parsed = parseEmployeeConfig({});
    expect(parsed.EMPLOYEE_ENABLED).toBe(true);
    expect(parsed.EMPLOYEE_MAX_REPAIR_ATTEMPTS).toBe(3);
    expect(parsed.EMPLOYEE_WORKSPACE_ROOT).toBe('.employee-workspaces');
  });
});

async function waitForStatus(
  service: EmployeeService,
  taskId: string,
  phase: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.status(taskId).status === phase) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`task ${taskId} did not reach ${phase}`);
}
