import { describe, expect, it } from 'vitest';

import {
  ToolManagerService,
  InMemoryToolRepository,
  createCalculatorSpecification,
  CALCULATOR_TOOL_NAME,
  ToolResultStatus,
  ToolCategory,
  ToolActorGroup,
  ToolSecurityLevel,
} from '../../../../src/agents/ag-004-tool-manager/index.js';
import { ToolConfigSchema } from '../../../../src/agents/ag-004-tool-manager/config/schema.js';
import type { ToolActor } from '../../../../src/agents/ag-004-tool-manager/types/index.js';

const config = ToolConfigSchema.parse({});
const ns = 'calc-ns';

const mgrActor: ToolActor = {
  group: ToolActorGroup.ToolManager,
  id: 'mgr-calc',
  namespaces: [ns],
  securityClearance: ToolSecurityLevel.Internal,
};

const actor: ToolActor = {
  group: ToolActorGroup.Orchestrator,
  id: 'orch-calc',
  namespaces: [ns],
  securityClearance: ToolSecurityLevel.Internal,
};

async function makeCalc() {
  const repo = new InMemoryToolRepository();
  const service = new ToolManagerService({ repository: repo, config });
  const def = await service.register(createCalculatorSpecification(), mgrActor, ns);
  const execute = async (expression: string) => {
    const result = await service.execute(
      CALCULATOR_TOOL_NAME,
      { expression },
      { actor, namespace: ns, traceId: 't' },
    );
    return {
      status: result.status,
      errorCode: result.errorCode,
      output: (result.output ?? null) as { result: number; operation: string } | null,
    };
  };
  return { service, def, execute, repo };
}

describe('AG-004 Calculator tool - correctness', () => {
  it('is registered in the COMPUTATION category', async () => {
    const { def } = await makeCalc();
    expect(def.category).toBe(ToolCategory.Computation);
    expect(def.version).toBe('1.0.0');
    expect(def.name).toBe(CALCULATOR_TOOL_NAME);
  });

  it('adds, subtracts, multiplies, divides', async () => {
    const { execute } = await makeCalc();
    expect((await execute('2 + 3 * 4')).output).toEqual({ result: 14, operation: '2 + 3 * 4' });
    expect((await execute('10 - 4')).output?.result).toBe(6);
    expect((await execute('6 / 2')).output?.result).toBe(3);
    expect((await execute('(1 + 2) * 3')).output?.result).toBe(9);
  });

  it('handles parentheses and exponentiation', async () => {
    const { execute } = await makeCalc();
    expect((await execute('2 ^ 3')).output?.result).toBe(8);
    expect((await execute('(2 + 3) ^ 2')).output?.result).toBe(25);
  });

  it('handles decimal and unary minus', async () => {
    const { execute } = await makeCalc();
    expect((await execute('-3 + 5')).output?.result).toBe(2);
    expect((await execute('1.5 + 2.5')).output?.result).toBe(4);
  });
});

describe('AG-004 Calculator tool - safety & fail-closed', () => {
  it('rejects division by zero as EXECUTION_FAILED', async () => {
    const { execute } = await makeCalc();
    const r = await execute('1 / 0');
    expect(r.status).toBe(ToolResultStatus.ExecutionFailed);
    expect(r.errorCode).toBe('TOOL_EXECUTION_FAILED');
  });

  it('rejects invalid characters (no injection surface)', async () => {
    const { execute } = await makeCalc();
    expect((await execute('require("fs")')).status).toBe(ToolResultStatus.ValidationFailed);
    expect((await execute('__proto__')).status).toBe(ToolResultStatus.ValidationFailed);
    expect((await execute('2 + 2; console.log(1)')).status).toBe(ToolResultStatus.ValidationFailed);
  });

  it('rejects overflow beyond the magnitude cap', async () => {
    const { execute } = await makeCalc();
    expect((await execute('9999999999999999 * 9999999999999999')).status).toBe(
      ToolResultStatus.ExecutionFailed,
    );
  });

  it('rejects malformed expressions', async () => {
    const { execute } = await makeCalc();
    expect((await execute('2 +')).status).toBe(ToolResultStatus.ExecutionFailed);
    expect((await execute('(&)')).status).toBe(ToolResultStatus.ValidationFailed);
  });

  it('rejects an oversized expression (bounded input)', async () => {
    const { execute } = await makeCalc();
    const big = '1+1'.repeat(200);
    const r = await execute(big);
    expect([ToolResultStatus.ValidationFailed, ToolResultStatus.ExecutionFailed]).toContain(
      r.status,
    );
  });
});
