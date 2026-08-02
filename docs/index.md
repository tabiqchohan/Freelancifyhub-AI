# Freelancify AI — Documentation Index

The official documentation set for the Freelancify AI ecosystem. All documents
are governed by the source-of-truth chain below.

## Document hierarchy

| Layer               | Document                                                                               | Status            | Governs                         |
| ------------------- | -------------------------------------------------------------------------------------- | ----------------- | ------------------------------- |
| **Requirements**    | [`prompts/`](../prompts/README.md) originals (prompts1–prompts10)                      | —                 | Spec origins                    |
| **Architecture**    | [`freelancify-ai-blueprint-v1.0.md`](./freelancify-ai-blueprint-v1.0.md)               | Official          | _How_ the system is architected |
| **Product**         | [`product-requirements-v1.md`](./product-requirements-v1.md)                           | Official PRD      | _What_ we build and _why_       |
| **Components**      | [`agent-catalog-v1.md`](./agent-catalog-v1.md)                                         | Official registry | Every AI agent (AG-NNN)         |
| **Component specs** | [`master-orchestrator-specification-v1.md`](./master-orchestrator-specification-v1.md) | Official          | AG-001 Master Orchestrator      |
| **Component specs** | [`shared-memory-architecture-v1.md`](./shared-memory-architecture-v1.md)               | Official          | AG-002 Shared Memory            |
| **Component specs** | [`tool-registry-architecture-v1.md`](./tool-registry-architecture-v1.md)               | Official          | AG-004 Tool Manager & Registry  |
| **Component specs** | [`knowledge-base-architecture-v1.md`](./knowledge-base-architecture-v1.md)             | Official          | AG-003 Knowledge Manager        |
| **Standard**        | [`agent-development-kit-v1.md`](./agent-development-kit-v1.md)                         | Official          | Agent Development Kit (ADK)     |
| **Review**          | [`architecture-review-v1.md`](./architecture-review-v1.md)                             | Independent       | Pre-implementation audit        |
| **Reference**       | [`architecture.md`](./architecture.md)                                                 | Reference         | Repo/runtime foundation         |
| **Reference**       | [`ai-ecosystem.md`](./ai-ecosystem.md)                                                 | Reference         | AI folder/agent conventions     |
| **Reference**       | [`getting-started.md`](./getting-started.md)                                           | Guide             | Setup & commands                |

## Reading order

1. `freelancify-ai-blueprint-v1.0.md` — architecture
2. `product-requirements-v1.md` — requirements
3. `agent-catalog-v1.md` — the agents
4. `master-orchestrator-specification-v1.md` → `shared-memory-architecture-v1.md` → `tool-registry-architecture-v1.md` → `knowledge-base-architecture-v1.md` — component specs
5. `agent-development-kit-v1.md` — AI authoring standard
6. `architecture-review-v1.md` — independent pre-implementation audit

## Update policy

- New component specs must be added to this index and the PRD document map.
- Specs must never contradict the documents above them in the hierarchy; gaps
  are recorded as assumptions in the owning document.
