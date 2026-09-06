# Agentic Tool-Calling & Reasoning Loop — Sprint 18 v1

## 1. Objective

Introduce a **bounded, cancellable, deadline-aware, fail-closed agentic
tool-calling loop** on top of the Sprint 17 reasoning stack. Agents explicitly
opt into the loop by declaring the `agent.agentic` capability
(`LLM_AGENTIC_CAPABILITY = 'agent.agentic'`); every existing deterministic agent
— including the AG-004 calculator — is untouched and never triggers an LLM call.

The loop is implemented in `src/agents/runtime/agentic/` and is driven entirely
through the public AG-004 tool-manager abstraction via the narrow
`AgenticToolCoordinator` port. AG-004 remains the sole execution/authorization
authority; the loop never bypasses it.

## 2. Scope

In scope:

- `src/agents/runtime/agentic/` domain module: state machine, contract types,
  loop limits config, structured-decision parsing, errors, event log, metrics,
  tool coordinator port + AG-004 adapter, prompt builder, barrel export.
- `src/llm/decisions/` structured-decision contracts and parser: the loop prompts
  the model for a decision envelope
  (`FINAL_RESPONSE | TOOL_CALL | CLARIFICATION_REQUIRED | ABORT`); only a valid,
  bounds-checked decision drives a transition.
- `ProductionAgentExecutor` integration: capability-driven, mapping every
  terminal `AgenticLoopStatus` to a typed `ReasoningOutcome` agentic block
  (never a fabricated result).
- Compose-root wiring: independent `AgenticEventLog`, `AgenticLoopMetrics`, and
  `AgenticLoopService` plus a deterministic tool-actor builder.
- `GET /api/llm/status` extended with an `agentic` observability block (limits +
  event total + metrics snapshot; no prompts, secrets, or reasoning).
- Full unit/integration/regression suite.

Out of scope (deferred): streaming, multi-tool parallel dispatch, persistent
event/metric sinks, live API integration in the default suite, autonomous
agent self-execution beyond the bounded loop.

## 3. Architecture

```
AgenticRuntimeAgent (requiresAgentic: true)
        ↓
ProductionAgentExecutor  (capability: agent.agentic)
        ↓
AgenticLoopService  (state machine: IDLE→REASONING→…→TERMINAL)
        ↓            ├─ AgenticToolCoordinator (AG-004 adapter, actor-scoped)
        ↓            ├─ AgenticEventLog / AgenticLoopMetrics
        ↓            └─ AIReasoningService (shared Sprint 17 stack)
        ↓
structured decision (FINAL_RESPONSE | TOOL_CALL | CLARIFICATION_REQUIRED | ABORT)
```

- Every model decision must `parseStructuredDecision` successfully and land
  within the configured bounds before the loop acts on it.
- Tool execution is delegated to `AgenticToolCoordinator.execute(...)`; the
  default implementation `AgenticToolManagerAdapter` wraps the public
  `ToolManagerService` with a strict actor + namespace pinned from the runtime
  request.
- AG-001/002/003/004 remain untouched: the loop consumes only already
  access-controlled memory/knowledge context and already authorized tools.

## 4. Loop Lifecycle & State Machine

`src/agents/runtime/agentic/state.ts` — deterministic,
`AgenticLoopStateMachine` with `AGENTIC_TERMINAL_STATES`:

`Idle → Reasoning → ToolValidating → ToolExecuting → ToolResultProcessing →
(Reasoning | …terminal)`, plus `Clarification` and terminal
`Completed | Aborted | Cancelled | TimedOut | Failed | LimitReached`.

- All transitions are whitelisted; anything else throws
  `AgenticStateTransitionError` (guards against regression to boolean flags).
- Terminal states are explicit: completion, user-requested aborts, cooperative
  cancellation via `AbortSignal`, whole-operation deadline, bounds exhaustion,
  and internal failures are all distinguishable.

## 5. Structured Decision Contracts

`src/llm/decisions/`:

- Strict Zod discriminated union on `type`:
  - `FINAL_RESPONSE` — `{ response: string }` (bounded length).
  - `TOOL_CALL` — `{ tool: string, arguments: ToolDecisionArguments }`.
  - `CLARIFICATION_REQUIRED` — `{ question: string }`.
  - `ABORT` — `{ reason: string }`.
- `parseStructuredDecision(text)` returns the parsed union or throws with a safe
  error (no raw model text in messages).
- `extractDecisionEnvelope(text)` tolerates fenced JSON from chatty models.
- `isResponseWithinDecisionBounds(decision, limits)` enforces response length,
  argument size, and tool-name/argument byte budgets before any transition.
- Parsing is byte-bounded (`MAX_DECISION_PARSE_BYTES`); oversized bodies fail
  closed.

## 6. Configuration

`src/agents/runtime/agentic/config.ts` — Zod schema parsed by `src/app/env.ts`
into `Environment["agentic"]`; defaults keep the loop bounded with no config:

| Variable                          | Default | Meaning                                    |
| --------------------------------- | ------- | ------------------------------------------ |
| `AGENTIC_MAX_TURNS`               | `8`     | Max reasoning turns per operation          |
| `AGENTIC_MAX_TOOL_CALLS`          | `6`     | Max total tool calls                       |
| `AGENTIC_MAX_TOOL_CALLS_PER_TURN` | `1`     | Max tool calls executed per single turn    |
| `AGENTIC_MAX_TOOL_RESULT_BYTES`   | `8192`  | Max bytes of a single captured tool result |
| `AGENTIC_MAX_TOOL_CONTEXT_BYTES`  | `24576` | Accumulated tool-result context budget     |
| `AGENTIC_MAX_TOTAL_MS`            | `60000` | Whole-operation deadline (ms)              |
| `AGENTIC_MAX_REASONING_CALLS`     | `12`    | Max reasoning calls (turns + slack)        |
| `AGENTIC_MAX_TOKEN_BUDGET`        | `8000`  | Aggregated output-token guard              |

The schema is intentionally **non-strict** (unknown env keys ignored) matching
the repository convention for env-parsed configs. Invalid values fail fast at
compose-root boot.

`agenticLimitSummary(config)` maps config to a safe, loggable shape used by the
status endpoint.

## 7. AgenticLoopService

`src/agents/runtime/agentic/loop.ts` (`AgenticLoopService`):

- **Always returns a typed `AgenticLoopResult`; never rejects.** Terminal statuses
  map onto typed outcomes with a stable `errorCode`.
- Cooperative cancellation: `AbortSignal` is checked before each reasoning call
  and attributed to the in-flight tool execution.
- Deadline propagation: the remaining whole-operation budget becomes the tool
  timeout (`context.timeoutMs`), so a tool cannot outlive the loop.
- Tool-result capture is byte-bounded and context-truncated into the reasoning
  view (`feedBounded`); **raw tool output never reaches the result, events, or
  logs** — only bounded, sanitized metadata.
- Rejection/failure feedback: rejects and execution failures are fed back into
  the reasoning context so later decisions can recover.
- Usage aggregation: per-call `input/output/total` token counts roll up into the
  result and metrics.
- Availability: `isEnabled()` mirrors the reasoning stack (loop is unavailable
  whenever LLM reasoning is disabled → executor fails closed).

## 8. ProductionAgentExecutor Integration

`src/agents/runtime/executor.ts`:

- New optional DI options: `agenticLoop`, `agenticToolActor` (a
  `(request) => ToolActor | undefined` builder).
- Capability: agents with `agent.agentic` route through
  `resolveAgenticReasoning`; all others keep the Sprint 17 deterministic path
  (zero LLM calls).
- Fail-closed mapping of terminal statuses to exit codes:
  - `Completed` / `Clarification` / `Aborted` → success outcome with the agentic
    block (`status, turns, reasoningCalls, toolCalls, rejections, clarification?`).
  - `Cancelled` → `AGENTIC_LOOP_CANCELLED` (non-retryable).
  - `TimedOut` → `AGENTIC_LOOP_TIMEOUT`.
  - `LimitReached` → `AGENTIC_LOOP_LIMIT_REACHED`.
  - `Failed` → `AGENTIC_LOOP_FAILED`.
  - Loop missing/disabled → fail-closed `REASONING_UNAVAILABLE` (non-retryable).
- Deterministic fallback actor: `defaultAgenticToolActor(agentId)` (Orchestrator
  group, `${agentId}-agentic`, `['default']`); compose-root overrides it from the
  runtime request-actor registration when present.
- The loop runs inside the executor's cancellation/timeout envelope; a cancelled
  execution surfaces as `AGENTIC_LOOP_CANCELLED`, never a fake success.

## 9. RuntimeAgent Declaration

`src/agents/runtime/runtime-agent.ts`:

- `requiresAgentic?: boolean` option.
- Capability ids: `requiresAgentic` → `[...base, LLM_AGENTIC_CAPABILITY]`;
  otherwise `requiresReasoning` → `[...base, LLM_REASONING_CAPABILITY]`; else the
  base deterministic capability set.
- Message injection: `RuntimeReasoningContext.agentic` is available to the agent
  when the loop ran; enforcement requires
  `(requiresReasoning || requiresAgentic) && context.reasoning === undefined`
  to reject.

## 10. Observability

`src/agents/runtime/agentic/events.ts` — `AgenticEventLog` (in-memory,
append-only, AG-004-style `query/count/latest`):
`agentic.operation.started|completed|failed`, `agentic.reasoning.started|completed`,
`agentic.tool.authorized|rejected|started|completed|failed`, and timeout/cancel
events. Event records carry only safe identifiers, statuses, counts, and bounded
metadata — never prompts, raw responses, or tool output.

`src/agents/runtime/agentic/metrics.ts` — `AgenticLoopMetrics` snapshot:
operations/turns/toolCalls/toolCallSuccesses/toolCallFailures/toolCallRejections/
reasoningCalls/cancellations/timeouts/limitReached/failures/input-output-total
tokens, plus `totalDurationMs`. No high-cardinality labels.

`src/app/runtime.ts` — `GET /api/llm/status` now returns
`agentic: { enabled, limits, events: { total }, metrics }` (limits via
`agenticLimitSummary`; safe numbers only).

## 11. Compose-Root Wiring

`src/app/composition-root.ts`:

- `new AgenticEventLog()`, `new AgenticLoopMetrics()`,
  `new AgenticLoopService({ reasoning: aiReasoning, tools: new
AgenticToolManagerAdapter(toolManager), config: env.agentic, ... })`.
- `agenticToolActor` builder resolves the runtime request actor via a new
  `RequestActorRegistry.resolve(executionId)` lookup and falls back to the
  deterministic Orchestrator actor when unregistered.
- Services exposed on the composition services object for the status endpoint
  and executor DI.

## 12. Security

- The loop never sees a raw model trace: decisions are parsed from a bounded
  envelope and validated before transition.
- Tool results are captured byte-bounded and sanitized; raw output is excluded
  from every serialized result and log.
- The prompt instructs the model to only use tools listed by AG-004; unknown
  tool decisions fail closed (`AGENTIC_LOOP_FAILED`), never auto-authorize.
- The agentic tool actor is pinned to the runtime request's group/identity behind
  the `ToolActorGroup.Orchestrator` gate; execution stays in AG-004's scope.

## 13. Testing

New tests (46 across 5 files):

- `tests/unit/llm/decisions/parser.test.ts` — envelope extraction, strict parse,
  bounds checks, oversized-body rejection.
- `tests/unit/agents/runtime/agentic/state.test.ts` — legal/illegal transitions,
  terminal-state guards.
- `tests/unit/agents/runtime/agentic/config.test.ts` — defaults, limits, summary.
- `tests/unit/agents/runtime/agentic/loop.test.ts` — completion, clarification,
  abort, tool round-trip, rejection feedback, auth/execution failures, max-turns
  limit, cooperative cancellation, deadline-as-tool-timeout, event coverage,
  raw-output secrecy, metric totals. Scripted fakes (`FakeReasoning` +
  `FakeCoordinator`) keep the suite deterministic and off-network.
- `tests/unit/agents/runtime/executor-agentic.test.ts` — agentic routing,
  fail-closed `REASONING_UNAVAILABLE`, deterministic agents untouched, capability
  declaration precedence.
- `tests/unit/app/llm-integration.test.ts` — runtime smoke asserts the `agentic`
  status block for disabled and mock-enabled providers.

No live API calls in the default suite.

## 14. How to Enable Agentic Execution

1. Enable the LLM stack: `LLM_ENABLED=true`, `LLM_PROVIDER=mock` (or `http` with
   a key).
2. Declare an agent as agentic via `createRuntimeAgent({ requiresAgentic: true,
... })` (capability `agent.agentic` is added automatically).
3. Optional limits via `AGENTIC_*` (defaults are safe for a first run).
4. Callers use the existing runtime request path; the agentic block appears on
   the reasoning outcome with loop status, turns, reasoning/tool call counts, and
   rejections.

## 15. Known Limitations

- v1 executes at most one tool call per reasoning turn (`AGENTIC_MAX_TOOL_CALLS_PER_TURN=1`); parallel dispatch is deferred.
- No streaming; the loop awaits a complete decision each turn.
- Default event/metric sinks are in-memory; no persistence across restarts.
- Prompt-boundary defense remains v1 hardening, not full injection-proofing.

## 16. Deferred Work

- Parallel tool dispatch, streaming decisions, budget-aware batch execution.
- Persistent agentic event/metric sinks and audit retention.
- Live-provider integration tests behind an opt-in flag.
- Self-healing loops (model-initiated retries) and sub-agent spawning.

## Verification

- Tests: **1623 passed** (143 test files), up from 1577 / 138 files before
  Sprint 18; 46 new tests.
- Typecheck: **0 errors** (`tsc --noEmit`).
- ESLint: **0 errors** on all changed/new files.
- Build: `npm run build` success.
- Runtime smoke: `GET /api/llm/status` returns the `agentic` block with
  `enabled:false` (disabled) and `enabled:true` + default limits (mock),
  event/metric zeros before any run.
- Backward compatibility: AG-004 calculator (`10 / 2 + 7 → 12`) and all existing
  deterministic flows unchanged; boot requires no LLM key when the stack is
  disabled.
