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
- Home recent runs belong to the creating browser: persist only its created run IDs in localStorage and fetch those IDs, never the shared recent-runs list. Listing labels must not reveal pasted advisory text. Public replay visits must not add a run to browser history.
- Stack reads remain public, but all adds/removals require the owner `STACK_EDIT_KEY` bearer key. The UI stores it only in sessionStorage after server acceptance. Failed authentication is rate-limited across unlock and write endpoints. New installed versions require at least two dotted numeric parts; do not silently rewrite pre-existing version data.
- How it works may show only the explicitly configured `FEATURED_RUN_ID`; without it, show no run trace. Never substitute the global latest run.
- New-run input must be a complete CVE ID or at least 40 trimmed characters with a version/product clue. Use the same validation in the form and API, preserve rejected drafts, and reject before creating any run or consuming daily-cap usage. This shape check does not establish advisory facts.
- CVE extraction uses NVD structured fields without an LLM; pasted-text extraction and checklist wording alone may use the LLM. The brief records both paths.
- CVSS display priority is version 4.0 → 3.1 → 3.0 → 2.0, then Primary before Secondary, then NVD/CNA before other sources. Keep all alternate scores and provider/version labels; missing metadata stays explicitly unknown.
- NVD's excluded upper version boundary is evidence about affected ranges, not a verified fixed release. Both version sections must remain visible even when NVD data is absent.
- Saved-run playback derives local frames from persisted steps/attempts only. Playback never reruns the pipeline or fetches data, and recorded node durations are not replaced by animation timings.
- `PATCHBRIEF_MAX_RUNS_PER_DAY` defaults to 100 (UTC day). Missing keys and exhausted budgets use normal "Rule-based (no LLM)" processing. A run is degraded only after an attempted LLM call fails; input-size and per-IP limits still reject requests.

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
