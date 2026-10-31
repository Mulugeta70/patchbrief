---
name: History visibility
description: Intent behind browser-local recent runs and public replay
---

Browser-local home history is a visibility rule, not an authentication system. Public replay pages by run ID must remain supported.

**Why:** The user explicitly requested browser-only recent runs while retaining public replay by ID.

**How to apply:** Do not treat visiting a public replay as ownership or introduce authentication as part of history cleanup.

The How it works demo must use only the explicitly featured run, never an arbitrary visitor's latest run. Without a featured run, show no trace.

**Why:** The user explicitly prohibited other visitors' runs from appearing on that page.
