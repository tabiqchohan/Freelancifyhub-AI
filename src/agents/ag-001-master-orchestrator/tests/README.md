# Master Orchestrator — Tests

The unit tests that exercise this module are kept behind the repository test
convention so Vitest and coverage pick them up automatically. They live in:

```
tests/unit/agents/ag-001-master-orchestrator/*.test.ts
```

Each test imports from `src/agents/ag-001-master-orchestrator/...` using the
`.js` ESM suffix. Run them with:

```sh
npm test           # all suites
npm run test:coverage
```

Coverage is scoped to `src/**/*.ts` in `vitest.config.ts`.
