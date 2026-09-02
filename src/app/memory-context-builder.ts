import type { Logger } from 'pino';

import type { AgentExecutionRequest } from '../agents/ag-001-master-orchestrator/execution/index.js';
import type { MemoryContextLoadInput } from '../agents/ag-001-master-orchestrator/context/index.js';
import { createOrchestratorLogger } from '../agents/ag-001-master-orchestrator/utils/logger.js';
import type { RequestActorRegistry } from './request-actors.js';

export type { MemoryContextLoadInput };

/** Options for constructing a {@link MemoryAwareContextInputBuilder}. */
export interface MemoryAwareContextInputBuilderOptions {
  readonly actorRegistry: RequestActorRegistry;
  readonly logger?: Logger;
  /** Cap on retrieval results per namespace (default 5). */
  readonly maxResults?: number;
}

/**
 * Phase 5 — Derives a {@link MemoryContextLoadInput} for a production
 * {@link AgentExecutionRequest}.
 *
 * Execution ids follow the `exec_<requestId>` convention, so the request id is
 * recovered without redesigning AG-001's request shape. When no actor binding
 * or no namespaces exist the result is `undefined` (fail-closed: no memory is
 * provisioned). Retrieval failures are handled upstream by the executor and
 * degrade to empty context, never silently swallowed.
 */
export class MemoryAwareContextInputBuilder {
  private readonly actorRegistry: RequestActorRegistry;
  private readonly maxResults: number;
  private readonly logger: Logger;

  constructor(options: MemoryAwareContextInputBuilderOptions) {
    this.actorRegistry = options.actorRegistry;
    this.maxResults = options.maxResults ?? 5;
    this.logger = options.logger ?? createOrchestratorLogger('memory-context-builder');
  }

  build(request: AgentExecutionRequest): MemoryContextLoadInput | undefined {
    const requestId = derivation(request.executionId);
    const input = this.actorRegistry.resolveLoadInput(requestId, {
      query: textOf(request.inputs),
      maxResults: this.maxResults,
    });
    if (input === undefined) {
      this.logger.debug(
        { executionId: request.executionId, requestId },
        'no memory actor binding for execution; skipping memory load',
      );
    }
    return input;
  }
}

/** Recovers the request id from an execution id (`exec_<requestId>`). */
export function derivation(executionId: string): string {
  const match = /^exec_(.+)$/.exec(executionId);
  return match !== null ? match[1]! : executionId;
}

/** Pulls a short query text from the resolved inputs, when present. */
function textOf(inputs: Readonly<Record<string, unknown>>): string | undefined {
  const raw =
    (inputs['request.input'] as string | undefined) ??
    (inputs['input'] as string | undefined) ??
    (inputs['query'] as string | undefined);
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.slice(0, 200);
  }
  return undefined;
}
