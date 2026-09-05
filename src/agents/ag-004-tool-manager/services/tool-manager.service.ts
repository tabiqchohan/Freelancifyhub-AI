import type { Logger } from 'pino';

import { ToolEventType, ToolPermission, ToolSecurityLevel } from '../enums/index.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolJsonValue,
  ToolResult,
  ToolSpecification,
} from '../types/index.js';
import type { ToolActor } from '../types/index.js';
import type { LiveTool, ToolRegistry } from '../registry/index.js';
import { ToolRegistry as ToolRegistryImpl } from '../registry/index.js';
import type { ToolRepository } from '../repositories/interface.js';
import type { ToolRecord } from '../repositories/types.js';
import type { ToolAuthorizationService } from '../security/index.js';
import { DefaultToolAuthorizationService } from '../security/index.js';
import type { ToolMetrics } from '../metrics/index.js';
import { ToolMetrics as ToolMetricsImpl } from '../metrics/index.js';
import type { ToolEventLog } from '../events/log.js';
import type { ToolEvent } from '../events/index.js';
import type { ToolExecutor } from '../execution/index.js';
import { ToolExecutor as ToolExecutorImpl } from '../execution/index.js';
import type { ToolConfig } from '../config/schema.js';
import { defaultExecutionPolicy } from '../config/schema.js';
import {
  createToolId,
  normalizeToolName,
  normalizeToolVersion,
  nowIso,
  createTraceId,
} from '../utils/ids.js';
import { ToolConflictError, ToolNotFoundError, ToolAccessDeniedError } from '../errors/index.js';

/**
 * AG-004 Tool Manager service. Owns the in-memory registry and orchestrates
 * registration/versioning/enable/disable/removal plus management authorization,
 * while persisting portable definitions through the ToolRepository abstraction.
 * The service never depends directly on PostgreSQL.
 */

/** Dependencies for the tool service. */
export interface ToolManagerServiceDependencies {
  readonly repository: ToolRepository;
  readonly config: ToolConfig;
  readonly authorizationService?: ToolAuthorizationService;
  readonly eventLog?: ToolEventLog;
  readonly logger?: Logger;
  /** Pre-built registry (optional; a fresh one is created otherwise). */
  readonly registry?: ToolRegistry;
  /** Optional executor to expose. Created lazily if not provided. */
  readonly executor?: ToolExecutor;
  readonly metrics?: ToolMetrics;
}

export class ToolManagerService {
  readonly name = 'tool-manager-service';

  private readonly repository: ToolRepository;
  private readonly config: ToolConfig;
  private readonly authorizationService: ToolAuthorizationService;
  private readonly eventLog: ToolEventLog | undefined;
  private readonly logger: Logger | undefined;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly metrics: ToolMetrics;

  constructor(dependencies: ToolManagerServiceDependencies) {
    this.repository = dependencies.repository;
    this.config = dependencies.config;
    this.authorizationService =
      dependencies.authorizationService ?? new DefaultToolAuthorizationService();
    this.eventLog = dependencies.eventLog;
    this.logger = dependencies.logger;
    this.registry = dependencies.registry ?? new ToolRegistryImpl();
    this.metrics = dependencies.metrics ?? new ToolMetricsImpl();
    this.executor =
      dependencies.executor ??
      new ToolExecutorImpl({
        registry: this.registry,
        authorizationService: this.authorizationService,
        metrics: this.metrics,
        eventLog: this.eventLog,
        config: this.config,
      });
  }

  /** The tool registry (live definitions + handlers). */
  get registryApi(): ToolRegistry {
    return this.registry;
  }

  /** The tool executor. */
  get executorApi(): ToolExecutor {
    return this.executor;
  }

  /** The metrics accumulator. */
  get metricsApi(): ToolMetrics {
    return this.metrics;
  }

  /** True when AG-004 is enabled per config. */
  get enabled(): boolean {
    return this.config.TOOLS_ENABLED;
  }

  /** Health check: storage availability. */
  async healthAsync(): Promise<{ healthy: boolean; message: string }> {
    return this.repository.healthAsync();
  }

  /**
   * Registers a tool specification into the registry and persists a portable
   * definition to the repository. Fails closed on conflict.
   */
  async register(
    specification: ToolSpecification,
    actor: ToolActor,
    namespace: string,
  ): Promise<ToolDefinition> {
    this.assertManaged(actor, ToolPermission.Register, namespace);
    const name = normalizeToolName(specification.name);
    const version = normalizeToolVersion(specification.version);

    const live = this.buildLiveTool(specification, name, version);
    if (this.registry.exists(name)) {
      throw new ToolConflictError(`Tool ${name} already registered`, { details: { name } });
    }

    await this.registry.register(live);
    try {
      await this.repository.save(this.toRecord(live.definition));
    } catch (err) {
      // Roll back the in-memory registration on persistence failure (prevents
      // registry/storage divergence).
      await this.registry.remove(live.definition.id).catch(() => undefined);
      throw err;
    }

    this.emitRegistryEvent(ToolEventType.Registered, live.definition, actor, namespace);
    return live.definition;
  }

  /** Registers or replaces (version) a tool definition. */
  async registerOrReplace(
    specification: ToolSpecification,
    actor: ToolActor,
    namespace: string,
  ): Promise<ToolDefinition> {
    try {
      return await this.register(specification, actor, namespace);
    } catch (err) {
      if (err instanceof ToolConflictError) {
        return await this.update(specification, actor, namespace, true);
      }
      throw err;
    }
  }

  /** Updates/replaces an existing tool by name. */
  async update(
    specification: ToolSpecification,
    actor: ToolActor,
    namespace: string,
    _allowReplace = false,
  ): Promise<ToolDefinition> {
    this.assertManaged(actor, ToolPermission.Update, namespace);
    const name = normalizeToolName(specification.name);
    if (!this.registry.exists(name)) {
      throw new ToolNotFoundError(`Tool ${name} not registered`, { details: { name } });
    }
    const version = normalizeToolVersion(specification.version);
    const live = this.buildLiveTool(specification, name, version);
    const previous = this.registry.get(name);

    await this.registry.replace(live);
    try {
      await this.repository.save(this.toRecord(live.definition));
    } catch (err) {
      if (previous !== undefined) {
        await this.registry
          .replace({ definition: previous, handler: live.handler })
          .catch(() => undefined);
      }
      throw err;
    }

    this.emitRegistryEvent(ToolEventType.Updated, live.definition, actor, namespace);
    return live.definition;
  }

  /** Enables a tool by name. */
  async enable(nameRaw: string, actor: ToolActor, namespace: string): Promise<ToolDefinition> {
    this.assertManaged(actor, ToolPermission.Enable, namespace);
    const name = normalizeToolName(nameRaw);
    const updated = await this.registry.enable(name);
    if (updated === undefined) {
      throw new ToolNotFoundError(`Tool ${name} not registered`, { details: { name } });
    }
    await this.persistEnableState(updated, true, namespace);
    this.emitRegistryEvent(ToolEventType.Enabled, updated, actor, namespace);
    return updated;
  }

  /** Disables a tool by name. */
  async disable(nameRaw: string, actor: ToolActor, namespace: string): Promise<ToolDefinition> {
    this.assertManaged(actor, ToolPermission.Disable, namespace);
    const name = normalizeToolName(nameRaw);
    const updated = await this.registry.disable(name);
    if (updated === undefined) {
      throw new ToolNotFoundError(`Tool ${name} not registered`, { details: { name } });
    }
    await this.persistEnableState(updated, false, namespace);
    this.emitRegistryEvent(ToolEventType.Disabled, updated, actor, namespace);
    return updated;
  }

  /** Removes a tool by name. */
  async remove(nameRaw: string, actor: ToolActor, namespace: string): Promise<boolean> {
    this.assertManaged(actor, ToolPermission.Delete, namespace);
    const name = normalizeToolName(nameRaw);
    const live = this.registry.getLive(name);
    await this.registry.remove(name);
    if (live === undefined) {
      return false;
    }
    await this.repository.remove(live.definition.id).catch(() => undefined);
    this.emitRegistryEvent(ToolEventType.Removed, live.definition, actor, namespace);
    return true;
  }

  /** Gets a tool definition by name (reads registry). */
  get(nameRaw: string, actor: ToolActor, namespace: string): ToolDefinition | undefined {
    const name = normalizeToolName(nameRaw);
    this.assertManaged(actor, ToolPermission.Read, namespace);
    return this.registry.get(name);
  }

  /** Lists current tools (deterministic). */
  list(actor: ToolActor, namespace: string): readonly ToolDefinition[] {
    this.assertManaged(actor, ToolPermission.Read, namespace);
    return this.registry.list().items;
  }

  /** Executes a tool through the executor. */
  execute(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    return this.executor.execute(name, input, context);
  }

  /** Number of registered tools. */
  count(): number {
    return this.registry.count();
  }

  /** Returns true when a tool name is registered. */
  exists(nameRaw: string): boolean {
    return this.registry.exists(normalizeToolName(nameRaw));
  }

  /** Retrieves a portable record for a tool id (for inspection). */
  async getRecord(id: string): Promise<ToolRecord | undefined> {
    return this.repository.getById(id);
  }

  private buildLiveTool(specification: ToolSpecification, name: string, version: string): LiveTool {
    const policyBase = defaultExecutionPolicy(this.config);
    const policy = specification.executionPolicy ?? {};
    const securityLevel =
      specification.securityLevel ?? policyBase.securityLevel ?? ToolSecurityLevel.Internal;
    const executionPolicy = {
      timeoutMs: policy.timeoutMs ?? policyBase.timeoutMs,
      maxInputBytes: policy.maxInputBytes ?? policyBase.maxInputBytes,
      maxOutputBytes: policy.maxOutputBytes ?? policyBase.maxOutputBytes,
      retryPolicy: {
        maxRetries: policy.retryPolicy?.maxRetries ?? policyBase.retryPolicy.maxRetries,
        backoffBaseMs: policy.retryPolicy?.backoffBaseMs ?? policyBase.retryPolicy.backoffBaseMs,
        backoffMaxMs: policy.retryPolicy?.backoffMaxMs ?? policyBase.retryPolicy.backoffMaxMs,
      },
      concurrencyLimit: policy.concurrencyLimit ?? policyBase.concurrencyLimit,
      rateLimit: policy.rateLimit,
      allowedActorGroups: policy.allowedActorGroups,
      securityLevel,
    };

    const at = nowIso();
    const definition: ToolDefinition = {
      id: createToolId(name, version),
      name,
      description: specification.description,
      version,
      category: specification.category,
      inputSchema: specification.inputSchema,
      outputSchema: specification.outputSchema,
      permissions: specification.permissions ?? [],
      securityLevel,
      executionPolicy,
      enabled: true,
      metadata: specification.metadata ?? {},
      createdAt: at,
      updatedAt: at,
    };

    return { definition, handler: specification.handler };
  }

  private toRecord(definition: ToolDefinition): ToolRecord {
    const policy = definition.executionPolicy;
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      version: definition.version,
      category: definition.category,
      securityLevel: definition.securityLevel,
      permissions: definition.permissions.map((p) => ({
        permission: p.permission,
        scope: p.scope,
      })),
      executionPolicy: {
        timeoutMs: policy.timeoutMs,
        maxInputBytes: policy.maxInputBytes,
        maxOutputBytes: policy.maxOutputBytes,
        retryPolicy: {
          maxRetries: policy.retryPolicy.maxRetries,
          backoffBaseMs: policy.retryPolicy.backoffBaseMs,
          backoffMaxMs: policy.retryPolicy.backoffMaxMs,
        },
        concurrencyLimit: policy.concurrencyLimit,
        rateLimit: policy.rateLimit,
        allowedActorGroups: policy.allowedActorGroups,
        securityLevel: policy.securityLevel,
      },
      enabled: definition.enabled,
      metadata: definition.metadata as Readonly<Record<string, ToolJsonValue>>,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
    };
  }

  private async persistEnableState(
    definition: ToolDefinition,
    enabled: boolean,
    namespace: string,
  ): Promise<void> {
    void namespace;
    const existing = await this.repository.getById(definition.id);
    const stub = this.toRecord({ ...definition, enabled });
    const record: ToolRecord = {
      ...(existing ?? stub),
      enabled,
      updatedAt: definition.updatedAt,
    };
    const byName = await this.repository.list(
      { name: definition.name },
      { offset: 0, limit: 1, sortBy: 'name', sortDirection: 'asc' },
    );
    if (byName.total > 0) {
      await this.repository.update(record);
    } else {
      await this.repository.save(record);
    }
  }

  private emitRegistryEvent(
    type: ToolEventType,
    definition: ToolDefinition,
    actor: ToolActor,
    namespace: string,
  ): void {
    this.emitEvent({
      type,
      traceId: createTraceId(),
      occurredAt: nowIso(),
      namespace,
      toolId: definition.id,
      toolName: definition.name,
      toolVersion: definition.version,
      actorGroup: actor.group,
      actorId: actor.id,
      source: 'registry',
      service: 'tool-manager',
      severity: 'info',
      category: 'registry',
    });
  }

  private emitEvent(event: ToolEvent): void {
    if (this.eventLog === undefined) return;
    try {
      this.eventLog.append(event);
    } catch (err) {
      this.logger?.warn({ error: err }, 'failed to emit tool event');
    }
  }

  private assertManaged(actor: ToolActor, permission: ToolPermission, namespace: string): void {
    const decision = this.authorizationService.authorize({
      actor,
      permission,
      target: {
        toolId: '*',
        toolName: '*',
        toolVersion: '*',
        namespace,
        securityLevel: ToolSecurityLevel.Internal,
        enabled: true,
      },
    });
    if (!decision.allowed) {
      throw new ToolAccessDeniedError(decision.reason ?? 'Not authorized', {
        code: decision.code ?? 'TOOL_ACCESS_DENIED',
      });
    }
  }
}
