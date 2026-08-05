/**
 * Dependency injection abstractions for the Master Orchestrator. Interfaces
 * only — no implementation in Sprint 1. Concrete wiring arrives with the
 * execution sites in later sprints, but nothing below changes.
 */

/** A stable, nominal registration key for a service in the container. */
export interface ServiceKey<T> {
  readonly name: string;
  /** Uniqueness marker that links the key to the service type. */
  readonly __type: T;
}

/** Minimal, strongly typed container contract. */
export interface DependencyContainer {
  /** Registers a service instance under a key. */
  register<T>(key: ServiceKey<T>, instance: T): void;
  /** Resolves a registered service, throwing if absent. */
  resolve<T>(key: ServiceKey<T>): T;
  /** Returns whether a service is registered. */
  has<T>(key: ServiceKey<T>): boolean;
}

/** Creates a typed service key. */
export function createServiceKey<T>(name: string): ServiceKey<T> {
  return { name, __type: undefined as unknown as T };
}
