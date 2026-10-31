# PatchBrief

PatchBrief runs a source-grounded advisory review pipeline and stores runs, steps, attempts, and demo faults in PostgreSQL. The web app provides live traces and public saved-run replay.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (managed `PORT`)
- `pnpm --filter @workspace/api-server run test` — retry, validation, and client-boundary unit tests
- `npm test` — unit, HTTP idempotency, and database recovery tests. Creates a disposable development DB schema, isolates all test connections from live workers, then drops it. No API shutdown or external LLM/NVD access required.
- `pnpm --filter @workspace/api-server run test:integration` — lower-level integration entry point; prefer root `npm test` for safe database isolation.
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret for LLM-backed steps: `OPENAI_API_KEY` — OpenAI API key in Replit Tools > Secrets
- `LLM_MODEL` defaults to `gpt-4.1-nano`. All LLM calls cap output at 1,024 tokens and total prompt text at 16,000 characters; advisory excerpts are capped at 8,000 characters. Full source evidence remains stored and used for validation/fallback.
- `FEATURED_RUN_ID` optionally adds the featured replay link under `/how-it-works`'s live trace. Set this on the web service and restart/rebuild the frontend.
- `GITHUB_REPO_URL` supplies the footer's GitHub destination. Set this on the web service and restart/rebuild the frontend.
- The saved stack is shared app-wide (no accounts). Example items are seeded only once; removing them, even all of them, must survive restarts.
- CVE extraction uses NVD structured fields without an LLM; pasted-text extraction and checklist wording alone may use the LLM. The brief records both paths.
- Saved-run playback derives local frames from persisted steps/attempts only. Playback never reruns the pipeline or fetches data, and recorded node durations are not replaced by animation timings.
- `PATCHBRIEF_MAX_RUNS_PER_DAY` defaults to 100 (UTC day). After this budget, runs are accepted as degraded with no LLM calls; input-size and per-IP limits still reject requests.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/routes/runs.ts` — run creation and retrieval API
- `artifacts/api-server/src/patchbrief/` — database access, ordered runner, retry policy, external clients, and review steps
- `lib/db/src/schema/` — PostgreSQL table definitions

## Architecture decisions

- Demo worker crashes are run-local stops, never process exits. A crash deliberately leaves its running step/attempt unsaved; a later lease owner records the interruption.
- Completed steps are immutable during recovery. Any new external step must remain safe to execute more than once with the same input.
- `resume_count` counts worker claims, including the first start (1). The resumed badge appears only above 1 and shows the saved count directly.

## Product

PatchBrief accepts a CVE ID or pasted advisory text, retrieves NVD data when given a CVE ID, extracts advisory details, compares affected version ranges with the tracked stack, and returns a remediation brief through the API.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
