# Devyora backend

Central backend for the Devyora voice assistant. One assistant, one backend,
many platforms.

This is the **foundation**: configuration, database, the API envelope and
health. There is no authentication, no AI and no external integration yet —
those arrive in later chunks, and the module graph already has the seams
marked for them.

## Requirements

- **Node.js 22 or newer.** NestJS 12 ships as pure ESM, and the CommonJS build
  loads it through Node's `require(esm)` support, which landed in Node 22.
- PostgreSQL 16.
- Docker is optional — the database can be run any way you like.

## Running it

Start PostgreSQL (Compose is provided, but anything works):

```bash
docker compose up -d postgres
```

```bash
cp .env.example .env
```

```bash
npm install
```

```bash
npm run prisma:generate
```

```bash
npm run migrate:dev
```

```bash
npm run db:seed
```

```bash
npm run start:dev
```

Then: `http://localhost:3000/health/live` and `http://localhost:3000/docs`.

## Commands

| Command | What it does |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` / `npm run start:prod` | Compile to `dist/`, run it |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, type-aware |
| `npm test` | Vitest — unit and integration, needs the database |
| `npm run test:cov` | With coverage |
| `npm run migrate:dev` | Create and apply a migration locally |
| `npm run migrate:deploy` | Apply pending migrations — this is the deploy step |
| `npm run migrate:status` | What is applied and what is pending |
| `npm run db:seed` | Development data. Refuses staging and production. |
| `npm run db:studio` | Prisma Studio |

## Layout

```
src/
├── config/      environment schema, validation, the typed config document
├── common/      envelope, errors, filters, interceptors, pipes, decorators,
│                request context (correlation id)
├── database/    Prisma service, lifecycle, transactions, tenant scoping
├── modules/     feature modules — health today
├── providers/   external adapters: LLM, speech, OAuth        (Chunks 5, 7, 8)
├── gateways/    WebSocket                                     (Chunk 6)
├── jobs/        BullMQ queues and processors                  (Chunk 6)
├── events/      in-process domain events                      (Chunk 6)
└── security/    auth guard, ownership, rate limit, audit, crypto (Chunks 3, 8)
```

## Conventions

**API shape.** Everything lives under `/api/v1`. Health is deliberately
outside both the prefix and versioning, at `/health/live` and `/health/ready`,
so probes survive a version bump.

**Responses.** One success envelope and one error envelope, applied globally.
A route that must return something else — a probe, a stream — opts out with
`@RawResponse()`.

```jsonc
// success
{ "success": true, "data": {}, "timestamp": "…", "correlationId": "…" }
// error
{ "success": false, "code": "NOT_FOUND", "message": "…", "statusCode": 404,
  "details": [], "timestamp": "…", "correlationId": "…", "path": "…" }
```

Clients branch on `code`, never on wording or status alone.

**Correlation ids.** Every request gets one, echoed in `X-Correlation-Id` and
included in the body and the logs. An inbound id is honoured so a trace can
span client and server.

**Errors never describe the infrastructure.** No stack traces, no SQL, no
constraint names, in any environment — a misconfigured deployment should not
be able to start leaking. Detail goes to the log beside the correlation id.

**Liveness is not readiness.** Liveness says the process is alive, so a failing
check means restart. Readiness says it can serve, so a failing check means
take it out of rotation and leave it running. Only a dependency the service
genuinely requires can fail readiness: Redis reports `not-configured` today
and does not hold the service down.

**Ownership.** Every user-owned row carries `userId`, and repositories express
that through the helpers in `database/tenant-scope.ts`. Another user's row is
reported as **404, not 403** — confirming that an id exists is itself a
disclosure.

**Soft delete.** User content carries `deletedAt` and is purged later by a
retention job. `AuditLog` is append-only and survives account deletion with
its user reference nulled, so the record of what happened is pseudonymised
rather than destroyed.

**Migrations never run at boot.** Two replicas starting together must not race
on the same schema, so `migrate:deploy` is a separate pre-deploy step. The
Dockerfile's `CMD` starts the server and nothing else.

## Security notes for later chunks

`@Public()` already exists and is applied to the health routes. When the
global authentication guard is registered in Chunk 3 every route becomes
private by default, and only routes carrying that marker stay open — so
nothing is accidentally exposed by forgetting to add a guard.

No secret is ever committed. `.env.example` contains placeholders only, and
`.env` is ignored.
