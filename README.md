# LastResort

A limited-capacity ticket booking platform. The first release has one demo event, guest sessions, and immediate confirmation. S1-05 provides the Next.js foundation, PostgreSQL 17, migrations, seed data, and a health check. S1-06 adds API contracts and CI. S1-08/S1-09 provide the event details page and server-derived sale status. S1-10 adds server-managed guest sessions. S1-11 adds atomic one-ticket booking; S1-12 connects the browser booking journey and ownership-safe result reopening. The project interface, sample data, and documentation are in English.

## Run from a fresh checkout

Install Node.js 24 LTS, npm, and Docker with Compose. Start Docker first. If you use nvm, run `nvm use` to select the version in `.nvmrc`.

```sh
npm ci
cp .env.example .env.local
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run db:status
npm run dev
```

Open http://localhost:3000 for the demo event details and current sale status. Check database readiness with:

```sh
curl -i http://localhost:3000/api/health
```

A ready database returns HTTP 200 with `{"status":"ok","database":"ready"}`. An unreachable database or missing schema returns HTTP 503 with `{"status":"unavailable","database":"unavailable"}`. Responses contain no credentials or stack traces and are never cached.

The interface follows the [Ticket Studio frontend direction](FRONTEND_DIRECTION.md), using a self-hosted Space Grotesk font, warm paper surfaces, and a ticket layout. The font and its SIL Open Font License are in `src/app/fonts/`. No external font request is needed at runtime or build time.

When sales are open, **Review booking** opens `/review` with fresh event details, one general-admission ticket, and a Free total. Reviewing reserves no inventory. **Confirm reservation** establishes the browser's guest session and submits one booking. It is enabled only with current, open event details and a safe browser submission state. A successful server confirmation opens `/reservations/{reference}`. Bookmark that link to reopen the original ticket in the same browser; refreshing the result only reads the existing reservation. History remains future work. A failed availability refresh preserves the last details with an explicit stale-data warning and blocks confirmation until a successful refresh; a not-found response clears the old event.

After the first seed, `db:status` should show `live-sessions-demo`, Live Sessions (Demo), capacity 100, and remaining 100. The fictional event takes place at Demo Hall on November 21, 2026 at 19:00 (Asia/Bangkok). General admission is free, with one ticket per request. Sales run from October 1, 2026 at 07:00 to November 21, 2026 at 18:00 (Asia/Bangkok). These are fixed fixture dates; sales close when that window ends.

`POST /api/session` creates or resumes the guest owner for this browser. It accepts same-origin requests only, has no request body, and returns no JSON or session token. The server sends the opaque token in the `lastresort_guest` cookie with `HttpOnly`, `SameSite=Lax`, `Path=/`, and a fixed 30-day expiry; it adds `Secure` over HTTPS. PostgreSQL stores only the token's SHA-256 hash. Clearing the cookie or using another browser starts a new guest session and does not recover prior bookings.

`POST /api/reservations` requires that established session and a matching `Origin` header. Send `Content-Type: application/json` and exactly `{"eventId":"live-sessions-demo","quantity":1}` (maximum 1024 bytes), with no query parameters or owner/session fields. It returns HTTP 201 with the confirmed reference, status, quantity, creation time and event summary only after commit. Missing/expired sessions return 401, unknown events return 404, and unopened/closed/sold-out sales return 409. All responses use `Cache-Control: no-store`.

The transaction locks the event row, checks current database time after any lock wait, conditionally decrements inventory, and inserts the owned reservation on the same connection. An insert failure rolls back the decrement. Opening is inclusive; closing is exclusive. Migration `004_reservations.sql` adds the reservation constraints and owner/event indexes. Run `npm run db:migrate` before using the endpoint on an existing database.

Each accepted booking POST creates a new booking. `Idempotency-Key` is explicitly rejected with HTTP 400 before database access until persistent retry support in S2-03. The S1-12 browser guard saves a local operation identity in `sessionStorage` before sending and prevents repeated clicks and resubmission after reload in the same tab. A timeout, unavailable response or malformed success leaves an unknown outcome and blocks further confirmation. It never automatically retries a booking. Storage that cannot be read safely also blocks confirmation. These browser safeguards do not provide server idempotency or cross-tab coordination. Do not clear browser data or book from another tab to recover an unknown outcome. Lost-response discovery, retry support and history remain Sprint 2 work.

`GET /api/reservations/{reference}` requires the original valid guest session. It returns the original confirmed reference, status and event summary with `Cache-Control: no-store`. Missing/expired sessions return 401. Unknown and cross-owner references both return the same 404 response; malformed UUIDs and query parameters return 400 before database access. Reads never create sessions, reservations or inventory changes. The result page offers safe read retries for loading errors. **Reserve another ticket** explicitly starts a new booking after a known confirmation.

Migrations can be run repeatedly and record which files have been applied. Seed only inserts a missing event: it never overwrites an existing event or replenishes inventory. The fixture uses 100 tickets for backlog tests; the earlier UX prototype used three tickets to make exploration quicker.

For an existing demo database, run `npm run db:migrate` to translate its ticket type to English. This migration changes only the original demo label and preserves remaining tickets and other event data.

## Configuration

The app and database commands load `.env.local` through Next.js. Process environment variables override file values. Both settings are required:

| Setting | Meaning |
| --- | --- |
| `APP_ENV` | `demo`, `test`, or `production`; identifies the data environment separately from Next.js's `NODE_ENV` |
| `DATABASE_URL` | PostgreSQL connection URL including the database name |
| `APP_ORIGIN` | Optional canonical `http://` or `https://` origin, without a path. Set it when a reverse proxy changes the request host or scheme; forwarded host headers are not trusted. |

The example credentials are for the local container only. Port 55432 is bound to loopback. Do not use these credentials for an online service. Keep real configuration in `.env.local` or hosting environment variables. All `.env*` files except `.env.example` are ignored. Never put database credentials in `NEXT_PUBLIC_` variables.

If required configuration is missing, `npm run dev` and `npm start` stop before starting the server and report the missing names, for example `Missing configuration: APP_ENV, DATABASE_URL`. Invalid URLs report `DATABASE_URL` without printing its value. Database command failures do not expose connection details.

Use PostgreSQL 17 for local development, CI, and the demo. Database commands reject other major versions. Use the supplied Compose service or create a separate PostgreSQL 17 database and update `DATABASE_URL`.

## Reset test or demo data

This command clears LastResort event data in the selected database and seeds it again in one transaction. Use it only for disposable fixtures:

```sh
npm run db:reset -- --confirm-reset
```

With `APP_ENV=demo`, the database name must be `lastresort_demo` or `lastresort_demo_<suffix>`. With `APP_ENV=test`, use `lastresort_test` or `lastresort_test_<suffix>`. Suffixes may contain a–z, 0–9, or underscores. The command checks the actual connected database name and the persisted environment marker created by migration. It refuses mismatching or production markers even if `.env.local` says demo or test. Never rename a real database to make it look disposable.

Reset does not drop schemas or use CASCADE. When later tasks add tables that reference events, update the explicit reset table list and verify it again. Seed uses the same guards and cannot add demo data to production.

Stop the database while keeping its data:

```sh
docker compose stop
```

Restart it with `docker compose up -d --wait`. Data persists in a named volume.

## Verify the system

```sh
npm run typecheck
npm test
npm run build
npm start
```

Build and start require the example configuration. Building the event page does not require a reachable database; loading event details and the runtime health check do require a reachable database with migrations applied.

The typecheck command generates Next.js types before checking TypeScript, including on a fresh clone. Generated types, build output, local configuration, test reports, and the local `docs/` directory are ignored by Git. Keep the dependency lockfile, safe environment example, migrations, and tests in version control.

Run database integration tests in a dedicated, disposable database for this suite. Do not use an active demo or production database:

```sh
docker compose exec -T db createdb -U lastresort lastresort_test_foundation
TEST_DATABASE_URL=postgresql://lastresort:lastresort_local_demo@127.0.0.1:55432/lastresort_test_foundation npm run test:integration
```

If the database already exists, skip `createdb`. Integration tests cover repeated migrations and seed, seed without inventory replenishment, guest-session persistence and expiry, rejected resets for production or mismatching markers or missing confirmation, confirmed reset including reservations, and preservation of tables outside the app schema. S1-11 tests verify persisted ownership, two overlapping connections contending for one ticket with an observed database lock wait, rollback after a database-triggered insert failure, inventory/schema constraints, rejected sessions/events/sale windows, and sale closure during a lock wait. Exact opening/closing boundaries use the application's SQL on PostgreSQL with a controlled test-only clock. Wider concurrent workloads, retry replay and recovery remain Sprint 2 work.

After building, run `TEST_DATABASE_URL=<your-disposable-test-url> npm run test:http`. This starts the production server against that database to verify bodyless, nonempty-body, and cross-origin session requests plus real booking HTTP success, sold-out, invalid input, ownership rejection and origin/session defenses. It also reopens the same booking twice, compares the original response, checks missing/cross-owner sessions and indistinguishable unknown references, and verifies reads create no additional reservations. It checks the persisted reservation and inventory and cleans up its own fixtures. It refuses databases without a matching `lastresort_test...` name and test marker. The CI verification job runs these same checks.

For browser verification, use a dedicated disposable test database and check event → review → confirm → result → refresh. Verify loading, sold-out/error responses, repeated clicks while sending, missing cookies, cross-owner links and safe read retry. Simulate response loss after the reservation commits: the review must show an unknown outcome, preserve its local operation identity across reload, and send no second booking POST. Inspect the affected pages at 320, 390, 768, 1024 and 1440px, with keyboard focus, reduced motion and 200% text. Browser checks supplement the database tests; a simulated UI response alone does not prove a database guarantee.

## API contract and CI

[api/openapi.json](api/openapi.json) is the OpenAPI 3.0 contract. Each operation has an `x-implementation` marker: health, event details, guest sessions, atomic booking and owned reservation details are implemented. Retry behavior is finalized in S2-03; the current booking contract records the future retry contract separately.

The contract includes request/response examples, HTTP status codes, and errors. Booking requests allow one ticket and never accept client-supplied ownership. General errors use `{"error":{"code":"INVALID_REQUEST","message":"..."}}`. Health retains its existing 200/503 readiness responses; unsupported query parameters return a 400 error without accessing the database or echoing input. Session creation rejects missing or cross-origin `Origin` headers before database access.

```sh
npm run test:contract
```

Contract tests validate the OpenAPI document, its examples, booking input rules, and the actual health route's response status/body/headers with controlled database outcomes. Guest-session tests cover cookie creation/reuse, token hashing, expiry, origin checks, and safe errors. Reservation route tests validate actual responses against the contract, input and origin rejection before database access, session-derived ownership, business failures, commit/insert failures, client release and safe errors. Detail-route tests cover owner-scoped reads, invalid inputs, expired sessions, indistinguishable 404s and safe read failures. Browser-controller tests cover repeated clicks, persisted uncertain outcomes, definite rejection, failed session preparation and unavailable/corrupt storage. PostgreSQL integration tests verify repeated result reads and cross-owner access without changing entitlements, alongside atomicity and last-ticket correctness.

The [CI workflow](.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and manual dispatch. It installs from the lockfile, then runs typecheck, all unit/contract tests, PostgreSQL 17 integration tests, the production build, and the production-server HTTP regression checks. Any failure stops the job and marks the check failed. CI uses a disposable `lastresort_test_ci` database with no production secrets. TypeScript checks provide the initial static analysis; there is no separate lint command yet.

To reproduce CI locally, run the verification commands above and the integration tests with a dedicated test database. `APP_ENV` must be `test` when using a test database for database commands.

## References and inventory experiment

The setup references [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [node-postgres connections](https://node-postgres.com/features/connecting), and the [PostgreSQL Docker image](https://hub.docker.com/_/postgres). Exact dependency versions are recorded in `package-lock.json`.

The earlier inventory spike requires Python 3, `initdb`, `pg_ctl`, `psql`, and permission to use local shared memory:

```sh
python3 spikes/inventory/check.py
```

It creates and stops its own temporary database. The earlier PostgreSQL 14 results are in `spikes/inventory/result.json`; they are not results from the application on PostgreSQL 17.
