import type { MemoryActorGroup } from '../agents/ag-002-memory-manager/index.js';
import type { MemoryContextLoadInput } from '../agents/ag-001-master-orchestrator/context/index.js';

/**
 * Phase 5 — Request-scoped actor registry.
 *
 * AG-001's {@link OrchestrationRequest} deliberately carries no actor/memory
 * scope fields (Sprint 14 must not redesign AG-001). This registry supplies
 * the missing actor + authorized-namespace data for a given `requestId`,
 * keyed at composition-root wiring time so the production executor can derive
 * a {@link MemoryContextLoadInput} without touching AG-001 core types.
 *
 * This is not a second source of truth: it is an explicit, caller-owned
 * binding from a request id to the memory actor that will own the request.
 * Missing bindings fail closed (no namespaces ⇒ no memory load).
 */
export interface RequestActorBinding {
  readonly requestId: string;
  readonly traceId?: string;
  readonly actorGroup: MemoryActorGroup;
  readonly actorId?: string;
  readonly actorRole?: string;
  readonly namespaces: readonly string[];
  readonly securityClearance?: MemoryContextLoadInput['securityClearance'];
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectIds?: readonly string[];
}

/** A registry that resolves the memory actor for a request id. */
export class RequestActorRegistry {
  private readonly bindings = new Map<string, RequestActorBinding>();

  register(binding: RequestActorBinding): void {
    this.bindings.set(binding.requestId, binding);
  }

  unregister(requestId: string): void {
    this.bindings.delete(requestId);
  }

  get(requestId: string): RequestActorBinding | undefined {
    return this.bindings.get(requestId);
  }

  resolveLoadInput(
    requestId: string,
    overrides?: Partial<Pick<MemoryContextLoadInput, 'query' | 'maxResults'>>,
  ): MemoryContextLoadInput | undefined {
    const binding = this.bindings.get(requestId);
    if (binding === undefined || binding.namespaces.length === 0) {
      return undefined;
    }
    return {
      requestId: binding.requestId,
      traceId: binding.traceId ?? `runtime:${requestId}`,
      actorGroup: binding.actorGroup,
      actorId: binding.actorId,
      actorRole: binding.actorRole,
      namespaces: binding.namespaces,
      query: overrides?.query,
      maxResults: overrides?.maxResults,
      securityClearance: binding.securityClearance,
      organizationId: binding.organizationId,
      workspaceId: binding.workspaceId,
      projectIds: binding.projectIds,
    };
  }
}
