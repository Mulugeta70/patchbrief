# PatchBrief

PatchBrief runs an ordered placeholder analysis pipeline and stores each run and step in PostgreSQL.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret for LLM-backed steps: `OPENAI_API_KEY` — OpenAI API key in Replit Tools > Secrets

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/routes/runs.ts` — run creation and retrieval API
- `artifacts/api-server/src/patchbrief/` — database access, ordered runner, retry policy, external clients, and review steps
- `lib/db/src/schema/` — PostgreSQL table definitions

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

PatchBrief accepts a CVE ID or pasted advisory text, retrieves NVD data when given a CVE ID, extracts advisory details, compares affected version ranges with the tracked stack, and returns a remediation brief through the API.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
