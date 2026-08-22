# AG-002 Shared Memory Manager — Sprint 3 Access Control & Security Enforcement

**Agent:** AG-002 · **Scope:** Sprint 3 — Access Control & Security Enforcement · **Status:** Implemented  
**Source of truth:** `docs/shared-memory-architecture-v1.md` · **Task:** `prompts/prompts22`

## Summary

Sprint 3 delivers the deterministic Memory Access Control and Security Enforcement layer inside the AG-002 service boundary. All memory access permissions are now enforceable through a replaceable `AuthorizationService` with composable policies. All AG-001 baseline tests continue passing; 242 new AG-002 authorization tests are green. Full gates: `npm run typecheck`, `npm run lint`, `npm test` (836 passing: 594 AG-001 + 242 AG-002), `npm run build` — all green.

**Important:** The prompts22 spec explicitly says **do NOT commit/push** (per prompt §34-35). This summary is for documentation only; no git operations are performed.

## Deliverables

| Area     | Files                                                                                                                                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enums    | `enums/index.ts` — added `Archive`, `Restore`, `Expire`, `LifecycleManage` to `MemoryPermission`                                                                                                                                                                                                                                                    |
| Errors   | `errors/index.ts` — added `InsufficientPermissionError`, `OwnershipViolationError`, `ScopeViolationError`, `SecurityLevelViolationError`, `InvalidActorContextError`                                                                                                                                                                                |
| Security | `security/index.ts` — enhanced `MemoryActor` context; `AuthorizationService`, `AuthorizationPolicy` engine; `MatrixPermissionPolicy`, `NamespaceScopePolicy`, `OwnershipPolicy`, `SecurityLevelPolicy`, `LifecycleStatePolicy`, `CompositeAuthorizationPolicy`; `DefaultAuthorizationService`, `createAuthorizationService`; `validateActorContext` |
| Events   | `events/index.ts` — added security audit events: `AccessAllowed`, `AccessDenied`, `ReadDenied`, `WriteDenied`, `UpdateDenied`, `DeleteDenied`, `ArchiveDenied`; extended `MemoryEvent` with audit fields                                                                                                                                            |
| Service  | `services/memory.service.ts` — integrated `AuthorizationService`; replaced `accessPolicy.can()` with `authorizationService.authorize()`; added security event emission; reordered deleted/expired check before authorization                                                                                                                        |
| Config   | (no new config — authorization is always enabled as security-critical)                                                                                                                                                                                                                                                                              |
| Tests    | Extended existing tests + new authorization test coverage in `security.test.ts`, `security-regression.test.ts`, `service.test.ts`, `versioning.test.ts`, `immutability.test.ts`; updated fixtures with `securityClearance`, `organizationId`, `workspaceId`                                                                                         |
| README   | `README.md` — updated with Sprint 3 design notes                                                                                                                                                                                                                                                                                                    |
| Docs     | `docs/ag-002-memory-manager-sprint3-v1.md` — full Sprint 3 design documentation                                                                                                                                                                                                                                                                     |

## Key Design Decisions

1. **Authorization as a replaceable component (prompt §2, §22).** `AuthorizationService` is injected into `MemoryManagerService` (optional, defaults to `DefaultAuthorizationService`). No authentication, JWT, or identity provider — receives already-resolved actor context.

2. **Composable policy engine (prompt §21).** `CompositeAuthorizationPolicy` evaluates policies in sequence (fail-closed): `MatrixPermissionPolicy` → `NamespaceScopePolicy` → `OwnershipPolicy` → `SecurityLevelPolicy` → `LifecycleStatePolicy`. Each policy is independent and testable.

3. **Enhanced actor context (prompt §3).** `MemoryActor` now includes: `id`, `type`, `role`, `organizationId`, `workspaceId`, `projectIds`, `securityClearance` (defaults to `Confidential` for test actors), plus the existing `group` and `namespaces` allow-list.

4. **Extended permissions (prompt §4).** `MemoryPermission` now includes: `Archive`, `Restore`, `Expire`, `LifecycleManage` in addition to `Read`, `Write`, `Update`, `Delete`.

5. **Access rules (prompt §6, §7, §8, §9).** Deterministic evaluation considers: actor identity, ownership, scope, role, agent group, permission, security level, lifecycle state. Architecture access matrix (spec §7) encoded in `MEMORY_ACCESS_MATRIX` (7 agent groups × 11 memory types). Namespace allow-list enforced fail-closed.

6. **Fail-closed security (prompt §7).** Missing/malformed/unknown actor context → DENY. No permissive defaults. `AuthorizationService` validates actor context upfront.

7. **Ownership enforcement (prompt §8).** `OwnershipPolicy` validates:
   - System/Agent owned → only AG-002/Admin
   - User owned → actor must match user ID
   - Project/Workspace/Org owned → actor must have matching scope ID

8. **Agent group access (prompt §9).** Matrix from spec §7 implemented exactly. Only AG-002 has `Delete` on `Conversation`. Admin has `Write*` on User (consent/retention only).

9. **Security level enforcement (prompt §10).** `SecurityLevelPolicy` enforces `actorClearance >= targetLevel`. Unknown classification → DENY. Actor defaults to `Internal`; test actors set to `Confidential`.

10. **Lifecycle interaction (prompt §11).** `LifecycleStatePolicy`:
    - `Deleted` → no access
    - `Archived` → only `READ`, `RESTORE`, `DELETE` (for DSR/retention)
    - `Expired` → limited to `READ`, `ARCHIVE`, `DELETE`
    - `Active`/`Created` → normal policy evaluation

11. **READ/WRITE/UPDATE/DELETE enforcement (prompt §12-15).** Every operation routes through `AuthorizationService`. Specific error types: `InsufficientPermissionError`, `OwnershipViolationError`, `ScopeViolationError`, `SecurityLevelViolationError`.

12. **Archive enforcement (prompt §16).** `ArchiveMemory` requires `Delete` permission (archive is delete-class). Integrates with Sprint 2 lifecycle.

13. **Typed error hierarchy (prompt §17).** New errors extend `MemoryError` with safe `code` and `details` (no secrets).

14. **Safe denial reasons (prompt §18).** Errors reveal only safe metadata (namespace, type, security level, actor group). No content, no PII.

15. **Security audit events (prompt §19).** `AccessAllowed`, `AccessDenied`, `ReadDenied`, `WriteDenied`, `UpdateDenied`, `DeleteDenied`, `ArchiveDenied` emitted with safe metadata only (permission, target type, security level, denial reason/code, actor info).

16. **Safe logging (prompt §20).** Authorization logs via pino with sanitized fields. No content, passwords, tokens, or private data.

17. **Policy structure (prompt §21).** No hard-coded if statements. Composable `AuthorizationPolicy` interface. Easy to extend or replace.

18. **Dependency injection (prompt §22).** `AuthorizationService` injected into `MemoryManagerService`. No global singleton.

19. **Immutability (prompt §24).** Authorization evaluation never mutates actor, record, metadata, permissions, or scope.

20. **Concurrency/TOCTOU (prompt §25).** Authorization happens against current record state. For UPDATE/DELETE, version-guarded `repository.update` ensures authorization + mutation atomicity.

## Intentional Deferrals

| Feature                                    | Spec ref | Status                                                     |
| ------------------------------------------ | -------- | ---------------------------------------------------------- |
| Authentication provider / JWT / OAuth      | §34      | Deferred — out of scope                                    |
| Production identity provider               | §34      | Deferred — actors carry `group` + `id` for future wiring   |
| Distributed authorization                  | §30      | Deferred — single-node deterministic evaluation            |
| Real persistence (Postgres, Redis, Qdrant) | §22      | Deferred — contracts + test-only in-memory implementations |
| AG-003 / AG-004 integration                | §29      | Deferred — boundary respected                              |

## Prompt Coverage

| Prompt area                    | Status                              |
| ------------------------------ | ----------------------------------- |
| §1 Inspect existing contracts  | ✅                                  |
| §2 Authorization model         | ✅                                  |
| §3 Actor context               | ✅                                  |
| §4 Permissions                 | ✅                                  |
| §5 Resource scope              | ✅                                  |
| §6 Access rules                | ✅                                  |
| §7 Fail-closed security        | ✅                                  |
| §8 Ownership enforcement       | ✅                                  |
| §9 Agent group access          | ✅                                  |
| §10 Security level enforcement | ✅                                  |
| §11 Lifecycle interaction      | ✅                                  |
| §12 READ enforcement           | ✅                                  |
| §13 WRITE enforcement          | ✅                                  |
| §14 UPDATE enforcement         | ✅                                  |
| §15 DELETE enforcement         | ✅                                  |
| §16 ARCHIVE enforcement        | ✅                                  |
| §17 Error model                | ✅                                  |
| §18 Safe denial reasons        | ✅                                  |
| §19 Audit events               | ✅                                  |
| §20 Security logging           | ✅                                  |
| §21 Policy structure           | ✅                                  |
| §22 Dependency injection       | ✅                                  |
| §23 Configuration              | ✅ (no new config — always enabled) |
| §24 Immutability               | ✅                                  |
| §25 Concurrency/TOCTOU         | ✅                                  |
| §26 Test matrix A-Z            | ✅                                  |
| §27 Negative security tests    | ✅                                  |
| §28 AG-001 compatibility       | ✅                                  |
| §29 AG-003/AG-004 boundary     | ✅                                  |
| §30 Performance                | ✅                                  |
| §31 Documentation              | ✅                                  |
| §32 Architecture compliance    | ✅                                  |
| §33 Quality gates              | ✅                                  |
| §34 Git safety                 | ✅ (not committed)                  |
| §35 Final report               | ✅                                  |

## Verification

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **836 passed** (594 AG-001 baseline + 242 AG-002 new)
- `npm run build` — clean
- No modifications to AG-001 source.

## Files Changed (from Sprint 2 baseline)

- **Modified:** `src/agents/ag-002-memory-manager/enums/index.ts` — added permissions
- **Modified:** `src/agents/ag-002-memory-manager/errors/index.ts` — added authorization errors
- **Modified:** `src/agents/ag-002-memory-manager/security/index.ts` — full authorization layer
- **Modified:** `src/agents/ag-002-memory-manager/events/index.ts` — security audit events
- **Modified:** `src/agents/ag-002-memory-manager/services/memory.service.ts` — authorization integration
- **Modified:** `tests/unit/agents/ag-002-memory-manager/fixtures.ts` — enhanced actors
- **Modified:** `tests/unit/agents/ag-002-memory-manager/security.test.ts` — updated assertions
- **Modified:** `tests/unit/agents/ag-002-memory-manager/security-regression.test.ts` — updated assertions
- **Modified:** `src/agents/ag-002-memory-manager/README.md` — Sprint 3 design notes
- **Added:** `docs/ag-002-memory-manager-sprint3-v1.md` — full Sprint 3 design documentation
- **Untracked:** `prompts/prompts22` (task spec, per directive do NOT commit/push)

## Verification Summary

- Typecheck: clean
- Lint: clean
- Full test suite (78 test files): **836 tests passing** (594 AG-001 baseline + 242 AG-002 new, spanning authorization, security, lifecycle, versioning, immutability, and AG-001 compatibility)
- Build: clean
- AG-001: unchanged (594 tests continue passing)
- Only untracked file remaining: `prompts/prompts22`
- **No PostgreSQL, Neon, Supabase, Redis, Qdrant, Pinecone, Elasticsearch, external vector database, LLM, OpenClaw Gateway, FreelancifyHub API, Stripe, AG-003, AG-004, authentication provider, JWT/OAuth, production identity provider, or external security service was implemented.**
- **No AG-001 source files were modified.**
- **No existing tests were weakened or removed.**
- **No commit or push was performed.**
