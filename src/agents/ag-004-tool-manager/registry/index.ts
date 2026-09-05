import type { ToolDefinition } from '../types/index.js';
import type { ToolHandler } from '../types/index.js';
import { ToolConflictError } from '../errors/index.js';

/**
 * AG-004 Tool Registry — the authoritative, thread-safe in-process registry of
 * executable tool definitions. A tool must never become executable merely
 * because an arbitrary caller supplies its name; only registry-approved tools
 * execute. Returns immutable (frozen) definitions.
 */

/** A live tool binding: definition plus its executable handler. */
export interface LiveTool {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
}

/** Result of listing tools. */
export interface ToolListResult {
  readonly items: readonly ToolDefinition[];
  readonly total: number;
}

/** Options for the registry. */
export interface ToolRegistryOptions {
  /** Pre-created live tools (for dependency injection). */
  readonly initial?: readonly LiveTool[];
}

/**
 * Deep-freezes an object graph for immutability.
 *
 * zod schemas (z.ZodType) are deliberately skipped: freezing them breaks their
 * internal lazy def normalization (safeParse throws "Cannot redefine property:
 * shape"). Any plain data (metadata, policy, ids, timestamps) is still deeply
 * frozen. Freezing never throws or crashes registration.
 */
function isZodSchema(value: object): boolean {
  return typeof (value as { safeParse?: unknown }).safeParse === 'function';
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (isZodSchema(value)) {
    return value;
  }
  try {
    Object.freeze(value);
  } catch {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child !== null && typeof child === 'object') {
      deepFreeze(child);
    }
  }
  return value;
}

export class ToolRegistry {
  readonly name = 'tool-registry';

  private readonly byId = new Map<string, LiveTool>();
  private readonly byName = new Map<string, LiveTool>();

  /** Simple serialized mutex for safe concurrent mutation. */
  private queue: Promise<unknown> = Promise.resolve();

  private mutate<T>(fn: () => T): Promise<T> {
    const run = async (): Promise<T> => fn();
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Registers a tool. Fails on duplicate identity. */
  register(tool: LiveTool): Promise<void> {
    return this.mutate(() => {
      if (this.byId.has(tool.definition.id)) {
        throw new ToolConflictError(`Tool ${tool.definition.id} already registered`, {
          details: { id: tool.definition.id },
        });
      }
      const current = this.byName.get(tool.definition.name);
      if (current !== undefined) {
        throw new ToolConflictError(
          `Tool name ${tool.definition.name} already registered as ${current.definition.id}`,
          { details: { name: tool.definition.name, existing: current.definition.id } },
        );
      }
      const frozen: LiveTool = {
        definition: deepFreeze(tool.definition),
        handler: tool.handler,
      };
      this.byId.set(tool.definition.id, frozen);
      this.byName.set(tool.definition.name, frozen);
    });
  }

  /** Replaces/version-updates an existing tool by name. */
  async replace(tool: LiveTool): Promise<void> {
    const existing = this.byName.get(tool.definition.name);
    if (existing !== undefined) {
      await this.remove(existing.definition.id);
    }
    await this.register(tool);
  }

  /** Removes a tool by id (and its name binding). */
  remove(id: string): Promise<ToolDefinition | undefined> {
    return this.mutate(() => {
      const existing = this.byId.get(id);
      if (existing === undefined) {
        return undefined;
      }
      this.byId.delete(id);
      if (this.byName.get(existing.definition.name)?.definition.id === id) {
        this.byName.delete(existing.definition.name);
      }
      return existing.definition;
    });
  }

  /** Enables a tool by name. Immutable definitions are regenerated. */
  enable(name: string): Promise<ToolDefinition | undefined> {
    return this.mutate(() => this.setEnabled(name, true));
  }

  /** Disables a tool by name. */
  disable(name: string): Promise<ToolDefinition | undefined> {
    return this.mutate(() => this.setEnabled(name, false));
  }

  /** Gets a tool by id. */
  getById(id: string): ToolDefinition | undefined {
    return this.byId.get(id)?.definition;
  }

  /** Gets the current (latest) definition for a tool name. */
  get(name: string): ToolDefinition | undefined {
    return this.byName.get(name)?.definition;
  }

  /** Gets a live tool (definition + handler) by name. */
  getLive(name: string): LiveTool | undefined {
    return this.byName.get(name);
  }

  /** Returns true when a tool name is registered. */
  exists(name: string): boolean {
    return this.byName.has(name);
  }

  /** Resolves a version-specific tool id from a name + version. */
  resolveVersion(name: string, version: string): ToolDefinition | undefined {
    const live = this.byName.get(name);
    if (live === undefined) {
      return undefined;
    }
    if (version === undefined || version.trim().length === 0 || version === '*') {
      return live.definition;
    }
    if (live.definition.version === version) {
      return live.definition;
    }
    // Look up a specific version among the registered ids.
    const id = `tool:${name}:v${version}`;
    return this.byId.get(id)?.definition;
  }

  /** Lists all current definitions, deterministically sorted by name. */
  list(): ToolListResult {
    const items = [...this.byName.values()]
      .map((live) => live.definition)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { items, total: items.length };
  }

  /** Count of registered current tools. */
  count(): number {
    return this.byName.size;
  }

  private setEnabled(name: string, enabled: boolean): ToolDefinition | undefined {
    const existing = this.byName.get(name);
    if (existing === undefined) {
      return undefined;
    }
    const updated: LiveTool = {
      definition: deepFreeze({
        ...existing.definition,
        enabled,
        updatedAt: new Date().toISOString(),
      }),
      handler: existing.handler,
    };
    this.byId.set(updated.definition.id, updated);
    this.byName.set(name, updated);
    return updated.definition;
  }

  /** Clears the registry. Test helper. */
  clear(): Promise<void> {
    return this.mutate(() => {
      this.byId.clear();
      this.byName.clear();
    });
  }
}
