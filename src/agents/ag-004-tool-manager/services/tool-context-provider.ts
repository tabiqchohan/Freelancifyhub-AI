import type { ToolContextProvider } from '../../ag-001-master-orchestrator/context/interfaces/providers.js';
import type { ContextItem } from '../../ag-001-master-orchestrator/context/types/index.js';
import {
  ContextPriority,
  ContextSectionType,
  ContextSourceType,
} from '../../ag-001-master-orchestrator/context/types/index.js';
import type { ToolManagerService } from './tool-manager.service.js';
import type { ToolActor, ToolDefinition } from '../types/index.js';

/**
 * AG-004 -> AG-001 context adapter. Implements AG-001's ToolContextProvider so
 * the orchestrator can request a listing of available tools as context items
 * through a clean interface, without depending on AG-004 internals.
 *
 * Only safe metadata is surfaced (name, description, version, category). Tool
 * execution is never performed from context loading.
 */

/** Input for loading tool context. */
export interface ToolContextLoadInput {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly actorGroup: ToolActor['group'];
  readonly actorId?: string;
  /** Namespaces the actor may access (fail-closed; empty = deny). */
  readonly namespaces: readonly string[];
}

/** Options for constructing a ToolContextProviderAdapter. */
export interface ToolContextProviderAdapterOptions {
  readonly toolService: ToolManagerService;
}

export class ToolContextProviderAdapter implements ToolContextProvider {
  readonly source = ContextSourceType.TOOL;

  private readonly toolService: ToolManagerService;

  constructor(options: ToolContextProviderAdapterOptions) {
    this.toolService = options.toolService;
  }

  async load(input?: ToolContextLoadInput): Promise<readonly ContextItem[]> {
    if (!input || input.namespaces.length === 0) {
      return [];
    }

    const actor: ToolActor = {
      group: input.actorGroup,
      id: input.actorId,
      namespaces: input.namespaces,
    };

    let definitions: readonly ToolDefinition[];
    try {
      definitions = this.toolService.list(actor, input.namespaces[0] ?? 'default');
    } catch {
      return [];
    }

    return definitions.map((definition, index): ContextItem => ({
      id: definition.id,
      source: { type: ContextSourceType.TOOL, id: definition.id },
      section: ContextSectionType.TOOL,
      content: `[${definition.name}] v${definition.version} — ${definition.description}`,
      priority: ContextPriority.NORMAL,
      metadata: {
        name: definition.name,
        version: definition.version,
        category: definition.category,
        enabled: definition.enabled === true,
      },
      order: index,
    }));
  }
}

/** Creates a ToolContextProviderAdapter. */
export function createToolContextProvider(
  options: ToolContextProviderAdapterOptions,
): ToolContextProviderAdapter {
  return new ToolContextProviderAdapter(options);
}
