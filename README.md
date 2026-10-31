# PatchBrief

Paste a CVE ID or an advisory. Get a triage brief for the software you run, and see how every step went.

- Live app: https://patch-brief-runner.replit.app
- Source: https://github.com/Mulugeta70/patchbrief

## What it does

Checking every new advisory against the software you run is tedious. PatchBrief does the lookup and the comparison. It returns the severity, the affected and fixed versions, which items in a saved stack are affected, a short checklist, and a three-line message that can be pasted to a team.

Every run is saved step by step, so the "How it works" page shows what each step did, how long it took, and what happened when something went wrong. Any finished run can be replayed from its saved record.

## The five steps

| # | Step | What it does |
| --- | --- | --- |
| 1 | Fetch advisory | Looks up the CVE in the NVD API, or takes pasted advisory text |
| 2 | Extract facts | Reads affected products, versions and scores. CVE IDs use NVD's structured fields with no LLM |
| 3 | Assess stack | Compares affected version ranges with the saved stack, in plain code |
| 4 | Map remediation | Writes the checklist, from a template unless an LLM key is set |
| 5 | Write brief | Assembles the brief and the team message |

Each step is written to Postgres as running before it starts and saved with its result before the next one begins. Steps are safe to run twice with the same input.

## When things go wrong

| Failure | What the app does |
| --- | --- |
| Outside service times out, or returns a 5xx or 429 | Retries with backoff, and only for errors that can clear up on their own |
| LLM key missing or the LLM unavailable | Uses rule-based extraction and a checklist template, and says so in the brief |
| Server or worker dies mid-run | Another worker takes over the run's lease and resumes at the first unfinished step |
| Same request sent twice | An idempotency key returns the existing run |
| Bad or oversized input | Rejected before a run exists, and the text stays in the box |
| Too many requests | A per-IP rate limit and a daily run cap return a clear error |

A "Break it" panel on the home page injects a timeout, an HTTP 500, malformed JSON or a worker crash into a single run, so each path can be watched live and replayed afterward.

## What I did

I chose the task, designed the system, and built it with Replit's Agent one stage at a time. For each stage I wrote the prompt, ran the result myself, and only moved on when it held up.

1. **Picked the job.** I wanted a tool that checks a vulnerability advisory against the software I run, so the app does a real task and not a demo.
2. **Designed the pipeline and the failure handling before writing any code.** Five saved steps, a table of every failure I expected, and what the app should do for each.
3. **Data model and runner.** Runs, steps and a saved stack in Postgres, with each step saved before the next starts. I tested idempotency by sending the same key twice and checking for one run.
4. **Real steps.** NVD lookup and extraction. I decided CVE lookups should not use an LLM, since NVD already returns structured data, so the app runs with no API key and no model cost.
5. **Live trace.** Server-sent events, and a trace that picks up the current state after a refresh instead of resetting.
6. **Reliability.** Timeouts, retries, fallbacks, input limits and a daily run cap, so a public visitor cannot run up a bill or lose their input.
7. **Break it, crash recovery and replay.** Failure injection at the HTTP and LLM boundaries, a lease-based resume after a worker crash, and a replay that reads saved data only.
8. **Tested against real advisories**, including `CVE-2026-109618` and `CVE-2026-109619`, a pasted advisory, and bad input such as empty text, gibberish and oversized pastes. I pinned PHP 8.4.20 in my stack and confirmed it matched the affected range and the 8.4.27 boundary.
9. **Fixed what the testing showed.** A shared list anyone could edit became a stack only the owner can edit, with a server-enforced key and a Lock button. Recent runs became per-browser, so one visitor's pasted advisory never shows to another. A false "nothing to patch" became "could not determine." Unlabeled CVSS scores now name their version and source.
10. **Published it and pushed the source.**

## Code I wrote myself

The Agent wrote most of the code. These are the pieces I wrote or rewrote by hand, in `artifacts/api-server/src/patchbrief/`:

- **The retry function.** It decides which failures are worth retrying (timeouts, 429, 5xx) and which fail right away (not found, validation errors), uses exponential backoff with jitter, and waits for a `Retry-After` header when a service sends one.
- **The version matching in the assess step.** It compares a pinned version against NVD's affected ranges, including ranges with an excluded upper bound.
- **Tests for both,** covering a step that fails twice then succeeds, a failure that must not retry, and a version on each side of a range boundary.
- **The wording and labels** across the app, so it reads the way I would write it.

## Design decisions and tradeoffs

- **Save after every step.** It costs extra writes. A crash loses at most one step, and resuming is simple.
- **Idempotent steps.** Retry and resume are only safe if running a step twice gives the same result.
- **Completed steps are immutable during recovery.** Recovery never redoes finished work.
- **Worker crashes are run-local.** The demo crash stops one run's worker and never exits the process, so a visitor cannot take the app down.
- **Replay reads saved data only.** It makes no network calls, and the durations it shows are the recorded ones, not animation timings.
- **No LLM for CVE lookups.** An LLM is optional and only used for pasted text and checklist wording.
- **An excluded upper bound is not a fix.** NVD's affected range says where the affected versions stop. The brief says that and points to the vendor advisory.
- **Undetermined is not unaffected.** When the advisory or NVD lacks version data, the brief says it could not tell, instead of giving an all-clear.
- **Limits protect the budget.** Input size, a per-IP rate limit and a daily run cap are enforced on the server.

## Known limits

- One shared stack, edited only with an owner key. There are no user accounts.
- The runner lives in the server process. At larger scale I would move to a job queue with separate workers.
- Matching depends on NVD's product and version data. When NVD has none, the brief says so instead of guessing.
- NVD is rate-limited, so heavy use will see retries.

## Run it

Requires Node 24 and pnpm. No LLM key is needed.

```
pnpm install
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run dev
npm test
```

The web app is the `@workspace/patchbrief-web` package. Tests cover retry and validation, idempotency over HTTP, and recovery against a disposable database schema.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required) |
| `STACK_EDIT_KEY` | Owner key for editing the saved stack |
| `PATCHBRIEF_MAX_RUNS_PER_DAY` | Daily run cap (default 100) |
| `FEATURED_RUN_ID` | Run shown on the How it works page |
| `GITHUB_REPO_URL` | Footer link |
| `OPENAI_API_KEY`, `LLM_MODEL` | Optional LLM for pasted text and checklist wording |
