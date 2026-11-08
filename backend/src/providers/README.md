# providers

Adapters for anything outside this service: LLM, speech-to-text,
text-to-speech, push delivery, OAuth clients.

Each lives behind an interface owned by the module that consumes it, so a
provider can be swapped without touching a caller, and a mock is a peer of
the real thing rather than a special case.

Populated in Chunks 5 (LLM), 7 (speech) and 8 (OAuth).
