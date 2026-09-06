/**
 * Sprint 18 — Agentic Tool-Calling. Narrow tool execution port.
 *
 * The agentic loop must use AG-004 exclusively through its public abstraction.
 * This port wraps the {@link ToolManagerService} public API and never touches
 * repositories, storage, handlers, or policies directly.
 */

import type {
  ToolActor,
  ToolDefinition,
  ToolExecutionContext,
  ToolManagerService,
  ToolResult,
} from '../../ag-004-tool-manager/index.js';

/** Read-only tool metadata surfaced to the loop (safe, bounded). */
export interface AgenticToolInfo {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly category: string;
  readonly securityLevel: string;
  readonly enabled: boolean;
  readonly inputSchemaDescription: string;
}

/**
 * The narrow port the agentic loop uses to observe and execute tools.
 * Never exposes the full ToolManagerService shape or AG-004 internals.
 */
export interface AgenticToolCoordinator {
  /** Authorized Read lookup (returns undefined when missing or unauthorized). */
  get(name: string, actor: ToolActor, namespace: string): AgenticToolInfo | undefined;
  /** Authorized Read listing. */
  list(actor: ToolActor, namespace: string): readonly AgenticToolInfo[];
  /** Executes a tool through the AG-004 pipeline; never bypasses authorization. */
  execute(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

/** Adapter wrapping the real ToolManagerService public API. */
export class AgenticToolManagerAdapter implements AgenticToolCoordinator {
  constructor(private readonly service: ToolManagerService) {}

  get(name: string, actor: ToolActor, namespace: string): AgenticToolInfo | undefined {
    const def = this.service.get(name, actor, namespace);
    if (def === undefined) {
      return undefined;
    }
    return toInfo(def);
  }

  list(actor: ToolActor, namespace: string): readonly AgenticToolInfo[] {
    return this.service.list(actor, namespace).map(toInfo);
  }

  execute(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    return this.service.execute(name, input, context);
  }
}

/** Converts a tool definition into a safe, serializable info record. */
function toInfo(def: ToolDefinition): AgenticToolInfo {
  return {
    name: def.name,
    version: def.version,
    description: def.description,
    category: def.category,
    securityLevel: def.securityLevel,
    enabled: def.enabled,
    inputSchemaDescription: renderSchemaDescription(def.inputSchema as { _def?: unknown }),
  };
}

/**
 * Builds a compact, deterministic textual description of a zod schema. Never
 * exposes schema internals; only describes top-level field shapes for model
 * prompting.
 */
function renderSchemaDescription(schema: { _def?: unknown } | undefined): string {
  if (schema === undefined) {
    return '{}';
  }
  const def = schema._def as Record<string, unknown> | undefined;
  if (def === undefined) {
    return '{}';
  }

  const typeName = def['typeName'] as string | undefined;
  const shape = def['shape'] as unknown;
  if (typeName === 'ZodObject' && typeof shape === 'function') {
    try {
      const resolved = shape() as Record<string, { _def?: Record<string, unknown> }>;
      const keys = Object.keys(resolved).sort();
      if (keys.length === 0) {
        return '{}';
      }
      const entries = keys.map((key) => {
        const child = resolved[key]!;
        const childDef = child._def;
        const childTypeName = (childDef?.['typeName'] as string) ?? 'unknown';
        return `"${key}": <${formatZodType(childTypeName, childDef)}>`;
      });
      return `{ ${entries.join(', ')} }`;
    } catch {
      return '{}';
    }
  }
  return `{ <${typeName ?? 'unknown'}> }`;
}

function formatZodType(typeName: string, def?: Record<string, unknown>): string {
  switch (typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodLiteral':
      return `literal(${String(def?.['value'])})`;
    case 'ZodArray':
      return `array`;
    case 'ZodEnum':
      return 'enum';
    case 'ZodOptional':
      return 'optional';
    default:
      return typeName.replace(/^Zod/, '').toLowerCase();
  }
}
