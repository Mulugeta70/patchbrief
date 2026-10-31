---
name: Advisory evidence boundaries
description: Source-only facts and conservative uncertainty in PatchBrief
---

PatchBrief briefs may state facts only from the supplied advisory or the tracked stack. Missing advisory values remain null; uncertain product or version-range matches remain undetermined rather than inferred.

**Why:** The user explicitly required no invented values and advisory/stack-only facts.

**How to apply:** Extraction, enrichment, and fallback changes must preserve provenance and must not treat LLM guesses as advisory facts.

Empty affected-product extraction or an inconclusive stack comparison is uncertainty, not a no-action result. Reserve “Nothing to patch from your current list” for usable advisory version ranges and a conclusive no-match comparison.

**Why:** The user explicitly required that missing version evidence must never be presented as reassurance.

Per-item upgrade guidance may use an NVD excluded upper bound only for the matching product and the affected range branch containing the installed version. It must say the endpoint is outside NVD's affected range, not claim it is a vendor-confirmed fix.

**Why:** A product can have several affected release lines; choosing an arbitrary endpoint could recommend an older release or a different branch. Exclusion from an NVD interval does not establish that the vendor fixed the vulnerability.

**How to apply:** Preserve the vendor-confirmation caveat and existing advice when a suitable boundary cannot be established from saved evidence.
