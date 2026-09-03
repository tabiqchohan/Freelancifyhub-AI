# Knowledge

Curated, versioned knowledge base for the FreelancifyHub AI ecosystem.

This directory is the source of truth that agents ground their answers on
(RAG documents, policies, domain glossaries, product documentation).

Naming convention: `knowledge/<domain>/<topic>.md`.

Keep sources versioned and reviewed — agents cite these documents instead of
improvising.

## Managed by AG-003

Ingestion, normalization, chunking, versioning, lifecycle, authorization,
durable persistence, retrieval, and context building for programmatic knowledge
are implemented by the **AG-003 Knowledge Manager** (see
`docs/sprint15-knowledge-manager-v1.md` and the
`src/agents/ag-003-knowledge-manager/` subsystem). The static markdown files in
this directory are the curated source documents that AG-003 can ingest and
expose to agents; runtime-ingested documents are stored in the knowledge
subsystem's repository (Neon PostgreSQL in durable mode).
