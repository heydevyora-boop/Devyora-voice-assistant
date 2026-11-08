# security

Cross-cutting enforcement: the authentication guard, ownership guards, rate
limiting, the audit interceptor and envelope encryption for stored OAuth
tokens.

Kept apart from feature modules so a policy is defined once and applied
globally, rather than re-implemented per controller.

The markers these rely on already exist in `common/decorators` — `@Public()`
in particular — so that when the global auth guard is registered in Chunk 3
every route is private unless it has explicitly opted out.

Populated in Chunks 3 and 8.
