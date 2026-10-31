---
name: Intentional no-LLM mode
description: Distinguish deliberate rule-based processing from failed LLM processing
---

Missing LLM keys and exhausted LLM budgets select normal rule-based processing. Mark a run degraded only after an attempted LLM call fails.

**Why:** The user explicitly distinguished intentional no-LLM operation from failure.

**How to apply:** Preserve this distinction when adding processing modes or fallback paths; do not use the degraded flag simply because no model ran.
