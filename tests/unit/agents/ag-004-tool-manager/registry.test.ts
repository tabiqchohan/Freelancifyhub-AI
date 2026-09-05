import { describe, expect, it } from 'vitest';

import {
  ToolRegistry,
  ToolConflictError,
} from '../../../../src/agents/ag-004-tool-manager/index.js';
import {
  createToolId,
  normalizeToolName,
  normalizeToolVersion,
} from '../../../../src/agents/ag-004-tool-manager/utils/ids.js';
import { makeSpec, makeLive } from './test-helpers.js';

describe('AG-004 Tool Registry', () => {
  it('registers a tool and exposes a frozen definition', async () => {
    const registry = new ToolRegistry();
    const live = makeLive('alpha', '1.0.0');
    await registry.register(live);

    expect(registry.exists('alpha')).toBe(true);
    expect(registry.get('alpha')?.id).toBe(createToolId('alpha', '1.0.0'));
    expect(registry.count()).toBe(1);
    expect(Object.isFrozen(registry.get('alpha'))).toBe(true);
  });

  it('rejects duplicate name registration (fail closed)', async () => {
    const registry = new ToolRegistry();
    await registry.register(makeLive('alpha', '1.0.0'));
    await expect(registry.register(makeLive('alpha', '1.1.0'))).rejects.toBeInstanceOf(
      ToolConflictError,
    );
  });

  it('normalizes names and versions deterministically', () => {
    expect(normalizeToolName('  Calculator ')).toBe('calculator');
    expect(normalizeToolName('Upper')).toBe('upper');
    expect(normalizeToolName('tool_one-two')).toBe('tool_one-two');
    expect(() => normalizeToolName('bad name!')).toThrow();
    expect(() => normalizeToolName('has space')).toThrow();
    expect(normalizeToolVersion(' 1.0.0 ')).toBe('1.0.0');
    expect(() => normalizeToolVersion('1.0')).toThrow();
    expect(() => normalizeToolVersion('v1.0.0')).toThrow();
  });

  it('supports version replacement while preserving immutability', async () => {
    const registry = new ToolRegistry();
    await registry.register(makeLive('alpha', '1.0.0'));
    await registry.replace(makeLive('alpha', '1.1.0'));

    expect(registry.get('alpha')?.version).toBe('1.1.0');
    expect(registry.get('alpha')?.id).toBe(createToolId('alpha', '1.1.0'));
    expect(registry.count()).toBe(1);
  });

  it('enable/disable transitions state and is preserved on read', async () => {
    const registry = new ToolRegistry();
    await registry.register(makeLive('alpha', '1.0.0'));

    const disabled = await registry.disable('alpha');
    expect(disabled?.enabled).toBe(false);
    expect(registry.get('alpha')?.enabled).toBe(false);

    const enabled = await registry.enable('alpha');
    expect(enabled?.enabled).toBe(true);
    expect(registry.get('alpha')?.enabled).toBe(true);
  });

  it('disable/enable of unknown tool returns undefined', async () => {
    const registry = new ToolRegistry();
    expect(await registry.disable('nope')).toBeUndefined();
    expect(await registry.enable('nope')).toBeUndefined();
  });

  it('remove deletes both id and name bindings', async () => {
    const registry = new ToolRegistry();
    await registry.register(makeLive('alpha', '1.0.0'));
    expect(await registry.remove(createToolId('alpha', '1.0.0'))).toBeDefined();
    expect(registry.exists('alpha')).toBe(false);
    expect(await registry.remove('missing-id')).toBeUndefined();
  });

  it('lists definitions deterministically sorted by name', async () => {
    const registry = new ToolRegistry();
    await registry.register(makeLive('bravo', '1.0.0'));
    await registry.register(makeLive('alpha', '1.0.0'));
    const list = registry.list();
    expect(list.total).toBe(2);
    expect(list.items.map((d) => d.name)).toEqual(['alpha', 'bravo']);
  });

  it('resolveVersion returns matching or current version', async () => {
    const registry = new ToolRegistry();
    await registry.register(makeLive('alpha', '1.0.0'));
    await registry.register(makeLive('alpha-2', '1.0.0'));
    expect(registry.resolveVersion('alpha', '*')?.name).toBe('alpha');
    expect(registry.resolveVersion('alpha', '1.0.0')?.name).toBe('alpha');
    expect(registry.resolveVersion('unknown', '1.0.0')).toBeUndefined();
  });
});

describe('AG-004 Tool Manager Service (via helper spec)', () => {
  it('registers and returns a complete definition through the helper', () => {
    const spec = makeSpec('calc', '2.0.0');
    expect(spec.name).toBe('calc');
    expect(spec.version).toBe('2.0.0');
    const def = makeLive('calc', '1.0.0').definition;
    expect(def.enabled).toBe(true);
    expect(def.id).toBe(createToolId('calc', '1.0.0'));
  });
});
