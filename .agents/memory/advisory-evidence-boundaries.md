---
name: Advisory evidence boundaries
description: Source-only facts and conservative uncertainty in PatchBrief
---

PatchBrief briefs may state facts only from the supplied advisory or the tracked stack. Missing advisory values remain null; uncertain product or version-range matches remain undetermined rather than inferred.

**Why:** The user explicitly required no invented values and advisory/stack-only facts.

**How to apply:** Extraction, enrichment, and fallback changes must preserve provenance and must not treat LLM guesses as advisory facts.

Empty affected-product extraction or an inconclusive stack comparison is uncertainty, not a no-action result. Reserve “Nothing to patch from your current list” for usable advisory version ranges and a conclusive no-match comparison.

**Why:** The user explicitly required that missing version evidence must never be presented as reassurance.
