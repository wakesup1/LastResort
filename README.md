# LastResort

A limited-capacity ticket booking platform. The first release has one demo event, guest sessions, and immediate confirmation. S1-05 provides the Next.js foundation, PostgreSQL 17, migrations, seed data, and a health check. S1-06 adds API contracts and CI. S1-08/S1-09 provide the event details page and server-derived sale status. S1-10 adds server-managed guest sessions. S1-11 adds atomic one-ticket booking; S1-12 connects the browser booking journey and ownership-safe result reopening. S2-03 adds persistent owner-scoped idempotency; S2-07 adds safe structured diagnostics and booking-schema readiness. S2-05 adds same-browser booking history; S2-06 adds read-only recovery of the original operation after response loss. The project interface, sample data, and documentation are in English.

## Run from a fresh checkout

Install Node.js 24 LTS and npm. Use a PostgreSQL 17 database, such as the configured Neon database, or start the optional local Docker Compose service. If you use nvm, run `nvm use` to select the version in `.nvmrc`.

```sh
npm ci
cp .env.example .env.local
# Optional local database only; skip when using Neon.
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run db:status
npm run dev
```

For Neon, set `APP_ENV` and its `DATABASE_URL` in ignored `.env.local` before migrating; use the direct connection URL for migrations and concurrency tests, with TLS enabled. Do not replace an existing configured environment file with the example. No Docker service is needed when using Neon.

Open http://localhost:3000 for the demo event details and current sale status. Check database readiness with:

```sh
curl -i http://localhost:3000/api/health
```

A ready database returns HTTP 200 with `{"status":"ok","database":"ready"}`. An unreachable database or missing schema returns HTTP 503 with `{"status":"unavailable","database":"unavailable"}`. Responses contain no credentials or stack traces and are never cached.

The interface follows the [Ticket Studio frontend direction](FRONTEND_DIRECTION.md), using a self-hosted Space Grotesk font, warm paper surfaces, and a ticket layout. The font and its SIL Open Font License are in `src/app/fonts/`. No external font request is needed at runtime or build time.

When sales are open, **Review booking** opens `/review` with fresh event details, one general-admission ticket, and a Free total. Reviewing reserves no inventory. **Confirm reservation** establishes the browser's guest session and submits one booking. It is enabled only with current, open event details and a safe browser submission state. A successful server confirmation opens `/reservations/{reference}`. Bookmark that link to reopen the original ticket in the same browser; refreshing the result only reads the existing reservation. Open **Booking history** in the header or on the result page to find confirmed tickets at `/history`. History uses only the original guest cookies; it cannot recover bookings after cookie loss or in another browser. A failed availability refresh preserves the last details with an explicit stale-data warning and blocks confirmation until a successful refresh; a not-found response clears the old event.

After the first seed, `db:status` should show `live-sessions-demo`, Live Sessions (Demo), capacity 100, and remaining 100. The fictional event takes place at Demo Hall on November 21, 2026 at 19:00 (Asia/Bangkok). General admission is free, with one ticket per request. Sales run from October 1, 2026 at 07:00 to November 21, 2026 at 18:00 (Asia/Bangkok). These are fixed fixture dates; sales close when that window ends.

`POST /api/session` creates or resumes the guest owner for this browser. It accepts same-origin requests only, has no request body, and returns no JSON or session token. The server sends the opaque token in the `lastresort_guest` cookie with `HttpOnly`, `SameSite=Lax`, `Path=/`, and a fixed 30-day expiry; it adds `Secure` over HTTPS. PostgreSQL stores only the token's SHA-256 hash. Clearing the cookie or using another browser starts a new guest session and does not recover prior bookings.

`POST /api/reservations` requires that established session and a matching `Origin` header. Send `Content-Type: application/json`, a UUID `Idempotency-Key` header, and exactly `{"eventId":"live-sessions-demo","quantity":1}` (maximum 1024 bytes), with no query parameters or owner/session fields. It returns HTTP 201 with the confirmed reference, status, quantity, creation time and event summary only after commit. Missing/expired sessions return 401, unknown events return 404, and unopened/closed/sold-out sales return 409. All responses use `Cache-Control: no-store`.

The transaction locks the event row, checks current database time after any lock wait, conditionally decrements inventory, and inserts the owned reservation on the same connection. An insert failure rolls back the decrement. Opening is inclusive; closing is exclusive. Migration `004_reservations.sql` adds the reservation constraints and owner/event indexes. Run `npm run db:migrate` before using the endpoint on an existing database.

Each deliberate new booking uses a fresh key. S2-03 requires one UUID `Idempotency-Key`; missing or malformed keys return 400 before database access. Migration `005_booking_operations.sql` stores the guest owner, key, normalized payload and outcome. The normalized payload is the exact validated `eventId` and integer `quantity: 1`: JSON property order/whitespace and UUID letter case do not create another operation. A different valid event with the same owner/key returns 409 `OPERATION_CONFLICT`; invalid quantities remain 400. Another owner has a separate key scope and cannot use the key to read the original result.

The first successful commit returns 201; sequential or concurrent replays return 200 with the original persisted reservation, including its original event summary, before checking current sale windows or inventory. `NOT_FOUND`, `SALES_NOT_OPEN`, `SALES_CLOSED` and `SOLD_OUT` are stored terminal business outcomes and replay their original status/code, even after availability changes. Keys have no automatic expiry or reuse. Invalid input/session failures are not stored. A database failure rolls back the operation row, decrement and reservation together. Concurrent retries wait on the database uniqueness constraint; the application statement timeout is 5 seconds. A timeout/503 can mean an unknown outcome: retry only the original key and payload with the original guest session. Never establish a replacement session or generate a new key to recover uncertainty. Expired or cleared guest cookies cannot recover an old owner.

The browser saves and sends the same local operation identity as its retry key, tagged with the idempotent protocol version. Older saved uncertain operations are kept blocked because they may predate server retry support. The browser guard writes to `sessionStorage` before sending and prevents repeated clicks and resubmission after reload in the same tab. A timeout, unavailable response or malformed success leaves an unknown outcome and blocks further confirmation. It never automatically retries a booking. Storage that cannot be read safely also blocks confirmation. Server idempotency protects retries of the same key; browser storage does not coordinate independently created operations across tabs. Do not clear browser data or book from another tab to recover an unknown outcome.

**Check booking result** on Review or Booking history explicitly reads `GET /api/booking-operations/{operationKey}` with the saved key and existing guest cookies. It never creates a session, retries the booking POST, or changes inventory. A committed result opens its original reservation, even if sales have since closed or sold out. Persisted `NOT_FOUND`, `SALES_NOT_OPEN`, `SALES_CLOSED` and `SOLD_OUT` outcomes resolve the original request as a known rejection. Only a resolved request permits a deliberate new booking. Reading an older ticket in history does not resolve a different uncertain request.

The recovery endpoint returns 200 with `{ eventId, outcome }`, where `outcome` is either `{ reservation }` (the original snapshot) or `{ code }` (a persisted business rejection). Invalid keys/query parameters return 400, missing/expired sessions return 401, and unknown, cross-owner or not-yet-committed operations share the same 404. Every response uses `Cache-Control: no-store`. A 404 is not proof of failure: the original transaction may still be running. Unavailable responses, malformed results, missing sessions and absent operations keep the saved request unknown and allow another read without starting a new purchase. This deliberately conservative recovery cannot resubmit a rolled-back operation; the HTTP booking contract still supports same-key retries by clients that retain the original owner. Clearing cookies cannot recover ownership. Legacy markers without the idempotent protocol/payload cannot be checked safely; retain result links and consult history in the original browser.

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

Run database integration tests in a dedicated, disposable PostgreSQL 17 database for this suite. Do not use an active demo or production database. For Neon, create a separate empty database such as `lastresort_test_concurrency` and use its **direct (unpooled)** connection URL as `TEST_DATABASE_URL`, with TLS enabled. The lock-observation tests require stable backend connections; use the direct URL from Neon's connection dialog. Keep the demo's `DATABASE_URL` unchanged. The suite passes the test URL to its migration/reset subprocesses and checks both the actual database name and persisted test environment marker before fixtures run.

With the optional local Compose database, create the separate test database this way:

```sh
docker compose exec -T db createdb -U lastresort lastresort_test_foundation
TEST_DATABASE_URL=postgresql://lastresort:lastresort_local_demo@127.0.0.1:55432/lastresort_test_foundation npm run test:integration
```

If the database already exists, skip `createdb` only if it is still dedicated and disposable. On Neon or another PostgreSQL 17 host, run `TEST_DATABASE_URL='<dedicated-direct-test-url>' npm run test:integration` instead; Docker is not required. Never commit connection strings. The suite resets test data and changes test environment markers to exercise safety guards.

Integration tests cover repeated migrations and seed, seed without inventory replenishment, guest-session persistence and expiry, rejected resets for production or mismatching markers or missing confirmation, confirmed reset including reservations, and preservation of tables outside the app schema. S1-11 tests verify persisted ownership, rollback after a database-triggered insert failure, inventory/schema constraints, rejected sessions/events/sale windows, and sale closure during a lock wait. Exact opening/closing boundaries use the application's SQL on PostgreSQL with a controlled test-only clock.

S2-01 expands concurrent-booking verification using the application's actual `reserveTicket` transaction:

- Two distinct guest owners contend for the last ticket on separate backend connections. Both must be observed waiting for database locks before the test releases its gate. Exactly one succeeds, the other receives `SOLD_OUT`, and the stored reference belongs to the winning owner.
- Capacity 100 receives 200 distinct operations, each with its own guest owner, through 20 worker connections (10 operations per worker). All 20 first operations must be observed waiting for database locks before release. Exactly 100 confirmations and 100 `SOLD_OUT` results are required, with 100 unique references matching the committed owners, quantities and statuses.
- An independent observer reads inventory and reservation count in one SQL snapshot after every operation. All 200 observations must satisfy `0 <= remaining <= capacity`, `confirmed <= capacity`, and `remaining + confirmed = capacity`. The final committed state must be remaining 0 and confirmed 100.

To focus on these cases after the suite has migrated a dedicated test database, run `TEST_DATABASE_URL='<dedicated-direct-test-url>' npm run test:integration -- -t 'last ticket|S2-01'`. This is transaction correctness evidence with at most 20 simultaneous booking operations, not a 200-connection HTTP load test or a performance benchmark. Repeat-run/failure-artifact tooling and recovery remain separate Sprint 2 tasks. S2-03 integration tests additionally verify sequential/concurrent replay, changed payloads, cross-owner isolation, all four persisted business outcomes, SQL lock-timeout retry, and rollback of the key with inventory after an insert failure. The existing CI integration step runs these tests against PostgreSQL 17 without a new job or dependency.

After building, run `TEST_DATABASE_URL=<your-disposable-test-url> npm run test:http`. This starts the production server against that database to verify bodyless, nonempty-body, and cross-origin session requests plus real booking HTTP success, sold-out, invalid input, ownership rejection and origin/session defenses. It also verifies normalized HTTP replay, payload conflict, owner-scoped keys, structured diagnostic correlation/redaction, reopens the same booking twice, compares the original response, checks missing/cross-owner sessions and indistinguishable unknown references, and verifies reads create no additional reservations. S2-06 drops the real booking response after commit, recreates the browser controller from its saved marker, explicitly checks the original operation and verifies one reservation with only one inventory decrement. It also checks recovery ownership, missing cookies, query validation and no session creation. Integration tests cover original snapshots after sale closure, absent/uncommitted/rolled-back operations and stored business rejections. It checks the persisted reservation and inventory and cleans up its own fixtures. It refuses databases without a matching `lastresort_test...` name and test marker. The CI verification job runs these same checks.

For browser verification, use a dedicated disposable test database and check event → review → confirm → result → refresh. Verify loading, sold-out/error responses, repeated clicks while sending, missing cookies, cross-owner links and safe read retry. Simulate response loss after the reservation commits: the review must show an unknown outcome, preserve its local operation identity across reload, and send no second booking POST. Choose **Check booking result** on Review or History: it must reopen the same ticket without creating another session or booking. Also check recovery with a closed/sold-out event, an unavailable recovery response, no completed operation and lost cookies; unknown results must stay blocked with an explicit read retry. Inspect the affected pages at 320, 390, 768, 1024 and 1440px, with keyboard focus, reduced motion and 200% text. Browser checks supplement the database tests; a simulated UI response alone does not prove a database guarantee.

## API contract and CI

[api/openapi.json](api/openapi.json) is the OpenAPI 3.0 contract. Each operation has an `x-implementation` marker: health, event details, guest sessions, atomic booking, owned reservation details, booking history and read-only operation recovery are implemented. The booking contract includes required retry keys, 200 replay, 201 creation and 409 payload conflicts. Booking and health responses include a server-generated `X-Request-Id`.

The contract includes request/response examples, HTTP status codes, and errors. Booking requests allow one ticket and never accept client-supplied ownership. General errors use `{"error":{"code":"INVALID_REQUEST","message":"..."}}`. Health retains its existing 200/503 readiness responses; unsupported query parameters return a 400 error without accessing the database or echoing input. Session creation rejects missing or cross-origin `Origin` headers before database access.

```sh
npm run test:contract
```

Contract tests validate the OpenAPI document, its examples, booking input rules, and the actual health route's response status/body/headers with controlled database outcomes. Guest-session tests cover cookie creation/reuse, token hashing, expiry, origin checks, and safe errors. Reservation route tests validate actual responses against the contract, input and origin rejection before database access, session-derived ownership, business failures, commit/insert failures, client release and safe errors. Detail-route tests cover owner-scoped reads, invalid inputs, expired sessions, indistinguishable 404s and safe read failures. Browser-controller tests cover persisted/sent retry keys, 200 replay, safe payload-conflict handling, repeated clicks, persisted uncertain outcomes, definite rejection, failed session preparation and unavailable/corrupt storage. PostgreSQL integration tests verify repeated result reads and cross-owner access without changing entitlements, alongside atomicity, last-ticket correctness and persistent idempotency. Readiness tests return unavailable when the operations table is missing even if events remain readable.

The [CI workflow](.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and manual dispatch. It installs from the lockfile, then runs typecheck, all unit/contract tests, PostgreSQL 17 integration tests, the production build, and the production-server HTTP regression checks. Any failure stops the job and marks the check failed. CI uses a disposable `lastresort_test_ci` database with no production secrets. TypeScript checks provide the initial static analysis; there is no separate lint command yet.

To reproduce CI locally, run the verification commands above and the integration tests with a dedicated test database. `APP_ENV` must be `test` when using a test database for database commands.

## Same-browser booking history (S2-05)

`GET /api/reservations` returns `{ "reservations": [...], "nextCursor": null }` for the server-validated guest cookie. It lists confirmed reservations only, so replaying one booking operation does not add history entries. The API accepts no owner/session selector. A valid new session receives an empty list; missing, forged or expired cookies receive 401. Reading history never creates or renews a session, writes a reservation or changes inventory. Every response uses `Cache-Control: no-store`.

Pages contain up to 20 tickets, newest first by creation time, with reference ascending as a stable tie-breaker. When `nextCursor` is non-null, pass it as `?before=<reference>` to read the next page. PostgreSQL compares the original timestamps, preserving sub-millisecond precision. Unknown and other-owner cursors both return the same 404. Unsupported, duplicate or malformed query parameters return 400 before database access. New bookings made between page reads appear on the next refresh.

`/history` provides loading, empty, session-loss and read-error states, plus **Refresh history**, **Load older bookings**, and links to the original ticket results. Network, timeout and server failures show a retryable read error rather than an empty list; an older-page failure retains the tickets already shown. A read that detects an absent or expired session clears displayed tickets. This uses the existing reservation table/index and requires no new migration. Checking/retrying an unknown booking operation remains S2-06.

`npm test` includes history route/contract and browser-loader checks. PostgreSQL integration tests verify multiple operations, replay without duplicate entries, cross-owner/expired-session rejection, read-only detail links and pagination across tied/sub-millisecond timestamps. `npm run test:http` additionally checks real history responses, pagination and ownership through the production server. For browser verification, check event → result → history → original result, refreshing, loading older tickets, retry after a failed read, new/expired sessions, keyboard navigation and layouts at 320–1440px with 200% text.

## Request diagnostics and readiness

Booking POST and health GET handlers emit one JSON log per response. `X-Request-Id` is generated by the server for every request; incoming request IDs are ignored. Use it to find the matching `requestId` log. Fields are `timestamp`, `level`, `event`, `route`, `requestId`, `status`, `outcome` and `durationMs`. Levels distinguish 5xx errors, 4xx rejections and successful responses. `durationMs` measures server handling/response assembly with a monotonic clock, not client network latency.

For valid retry-key headers, `operationKeyHash` correlates that key without exposing it. Once a session is validated, `operationId` hashes owner + normalized key: retries share it, and a different owner using the same key has a different operation ID. Neither hash authorizes access. Logs include no cookie/session token, raw key, owner/reference, request body, URL/query, credential, driver exception or stack. Outcomes use an allowlist of error codes. Pool failures emit a fixed `database_connection` event. A failing log sink does not alter a committed booking response.

Inspect these logs in the server terminal or the hosting log viewer. Group by `route`/`status`/`outcome` to count failures and examine `durationMs`; filter `requestId` for one response or `operationId` for the same owner's retries. These are per-request diagnostic records, not a durable audit log, metrics endpoint or performance baseline. No external telemetry service is configured.

`GET /api/health` preserves its 200/503 JSON shape and `Cache-Control: no-store`. One read-only query checks the required event/session/reservation/operation tables and columns, including on an empty database. It returns 503 for connection failures or missing booking schema. It checks database/schema readability, not a reservation write or public deployment. Apply migration 005 before starting this version; health remains unavailable until the required schema exists.

## References and inventory experiment

The setup references [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [node-postgres connections](https://node-postgres.com/features/connecting), and the [PostgreSQL Docker image](https://hub.docker.com/_/postgres). Exact dependency versions are recorded in `package-lock.json`.

The earlier inventory spike requires Python 3, `initdb`, `pg_ctl`, `psql`, and permission to use local shared memory:

```sh
python3 spikes/inventory/check.py
```

It creates and stops its own temporary database. The earlier PostgreSQL 14 results are in `spikes/inventory/result.json`; they are not results from the application on PostgreSQL 17.
