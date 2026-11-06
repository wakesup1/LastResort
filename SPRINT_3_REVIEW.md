# LastResort Sprint 3 Release Review and Retrospective

Reviewed on **6 November 2026, Asia/Bangkok**, for **S3-REV**: release the verified demo, review outcomes and run a retrospective. Its dependency, S3-07, was merged in [PR 23](https://github.com/wakesup1/LastResort/pull/23). The Sprint Goal is **“Deliver a working online demo with traceable verification and an explanation of the design.”**

The existing public deployment is available as the **Sprint 3 portfolio demo** within the first-release boundaries below. The current revision passed CI, the hosted booking journey and the bounded security probe. This review records that release; it changes documentation only and does not create another deployment, GitHub release or tag. The engineering evidence supports the Sprint Goal. Owner usability feedback and executed provider rollback/database-restore acceptance remain unverified; this review does not claim every Product Backlog acceptance criterion is closed.

## Release identity and scope

| Item | Verified identity or boundary |
| --- | --- |
| Public demo | [last-resort-five.vercel.app](https://last-resort-five.vercel.app/) |
| Released application revision | [`d6dde43665adfd2a2f8929545e3ea192e7fd5ff0`](https://github.com/wakesup1/LastResort/commit/d6dde43665adfd2a2f8929545e3ea192e7fd5ff0), the S3-07 merge on `main` |
| Production deployment | [8XdLHr6v4pQwtps2PYY2FE5bb3F5](https://vercel.com/wakesup1s-projects/last-resort/8XdLHr6v4pQwtps2PYY2FE5bb3F5). The Vercel dashboard showed Ready, Production, Current, source `d6dde43`, and the canonical demo domain assigned. Its displayed creation time was 6 November 2026 at 10:08:32 UTC (17:08:32 Bangkok). |
| Automated verification | [CI run 42200310575](https://github.com/wakesup1/LastResort/actions/runs/42200310575), existing `verify` job, same full revision; completed successfully at 17:09:12 Bangkok |
| Product boundaries | One fictional event, pooled free general admission, one ticket per confirmation, immediate entitlement and no payment. Review holds no inventory. A new operation can book again; the same operation replays its original outcome. |
| Ownership and recovery | Server-issued guest session; private result/history/recovery reads require the original owner. Clearing cookies, session expiry or changing browsers cannot recover prior ownership. An unknown result retains its original operation identity and offers an explicit read check. |
| Demo lifetime | Fixed sales close **21 November 2026 at 18:00 Bangkok**. Shared inventory is finite; this review intentionally consumed one ticket. No inventory was reset or replenished. |

The architecture, SQL/session decisions and tradeoffs are in the [README](README.md#architecture-and-decisions); the implemented HTTP contract is in [api/openapi.json](api/openapi.json). This is a fictional portfolio demonstration, with the existing free-service constraints described in the README. No paid service or billing change was made for this review.

## Verification at the released revision

CI used **Node.js 24.22.2, Linux x64 and PostgreSQL 17.11**, with a dedicated disposable PostgreSQL service database. Downloaded concurrency and failure summaries identify the exact release revision and `workingTreeDirty: false`. These checks ran in CI; they are not local reruns or failure injections into Vercel/Neon.

| Check | Actual result |
| --- | --- |
| Lockfile installation, typecheck and production build | Passed |
| Unit and contract suite | 220 tests passed across 15 files |
| PostgreSQL integration suite | 41 tests passed |
| Production-server HTTP suite | Passed session/origin protections, idempotency, owner isolation, history, response-loss recovery and diagnostic checks. Eight same-operation submissions produced one creation and seven replays. |
| Last-ticket contention | Three rounds passed. Each round used two owners/operations on two connections, observed both contenders waiting, then stored exactly one confirmation and one SOLD_OUT outcome with remaining 0. Ownership and cleanup passed. |
| Capacity contention | Three rounds passed. Each round used capacity 100 and 200 distinct operations over 20 worker connections; all 20 initial contenders were observed waiting. Each recorded 100 confirmations, 100 SOLD_OUT outcomes, zero failed workers, final remaining 0 / confirmed 100, correct ownership and completed cleanup. All 200 inventory observations per round satisfied the invariants. |
| Rollback at commit | Passed. Before retry: capacity 1, remaining 1, confirmed 0, operations 0. The original-key retry then produced one ticket and one operation. |
| Application crash before commit | Passed. Before and after application restart: remaining 1, confirmed 0, operations 0. Original-key retry then produced one ticket and one operation. |
| Committed response loss and application restart | Passed. Before/after recovery: capacity 1, remaining 0, confirmed 1, operations 2, incomplete operations 0. The second operation was a persisted sold-out outcome. Recovery and replay preserved the original ticket. |
| Failure-suite lifecycle | Three application starts; all three scenarios and fixture cleanup completed successfully. PostgreSQL stayed running. |

The [CI workflow](.github/workflows/ci.yml) and [repeatable verification commands](README.md#verify-the-system) define these workloads. The capacity test has at most 20 booking connections; it is not a 200-connection benchmark. The application-restart suite does not establish database-host recovery or multi-instance failover.

CI artifacts are retained remotely for 14 days. The downloaded reports and hosted screenshots/probe output are also retained locally under ignored `docs/verification/s3-rev/evidence/`. Those files are supporting evidence, not part of a fresh checkout. The essential revision, workload, environment and observed results are preserved here so the review remains understandable after remote artifact expiry.

## Hosted release checks

The in-app browser walkthrough used the canonical HTTPS domain on macOS. At approximately **17:14 Bangkok**, event details showed open sales and 91 remaining tickets. Review displayed one free general-admission ticket, the no-hold rule and the same-browser limitation. Confirmation visibly entered its pending state before the server-confirmed result appeared.

The result was reloaded, then opened through **My bookings**, which showed one confirmed booking in this guest session. Following its detail link reopened the same full reference and original 17:14 booking timestamp. A subsequent event read displayed **90 remaining**. These are browser observations, not a database reconciliation. Only one deliberate confirmation was made; reload, history and detail navigation were reads.

The result was inspected at a measured **432 × 825 CSS-pixel viewport**, with document width 432 and a wrapping ticket/reference. Attempts to set 320px and 1440px through the browser viewport control left the measured width at 432px; those attempts are not counted as successful responsive checks. The override was reset. The earlier [S3-01 walkthrough](README.md#ticket-flow-and-keyboard-walkthrough-s3-01) remains the historical mobile/desktop and keyboard evidence, with its original revision and limits. This release check is not a fresh accessibility audit.

At approximately **17:15 Bangkok**, the existing [deployment security probe](scripts/check-deployment-security.mjs) passed all **12 printed checks** against this deployment:

- HTTPS health returned ready with `no-store`; HTTP redirected to canonical HTTPS.
- Foreign-origin session/booking mutations and a forwarded-origin spoof were rejected; the preflight granted no cross-origin browser access.
- A new guest cookie had Secure, HttpOnly, SameSite=Lax, Path=/, a 30-day maximum age and no Domain. Resuming it did not replace the cookie.
- A forged owner payload was rejected; the fresh guest's private history was empty.
- The ticket just confirmed in the browser, queried with the probe's different guest, returned the same 404 body as an unknown reference. With no session it returned 401.
- The operation read remained private and `no-store`; checked responses did not expose the probe's token.

The probe created one additional guest session and no ticket. Its cross-owner input was a real confirmed reference, not a second invented nonexistent reference. No secrets, cookies or connection strings are included in the retained output. These checks do not establish every possible security property or inspect all provider logs.

## Sprint outcomes

The [Sprint 3 Backlog](https://docs.google.com/spreadsheets/d/1U80xjgXWKJRFEgKo3RHPHAhmMrqtIOpgvP3IaJZV3G4/edit#gid=1701106101) was read on 6 November 2026. It records S3-01 through S3-07 as Done and S3-REV as To do, with empty Evidence / Done output cells. It was not edited. Recorded statuses and estimates are not proof of acceptance or measured effort.

| Task | Outcome and evidence boundary |
| --- | --- |
| S3-01 / LR-T04 | Ticket flow, focus and responsive engineering checks are documented in the README. The local walkthrough explicitly leaves the owner's hands-on feedback pending; a Done status does not supply that feedback. |
| S3-02 / LR-T09 | A reproducible baseline, failed/limited attempts and bottleneck observations are [recorded](README.md#reference-measurement-2026-11-01). At revision `ee31908`, 200 requests at concurrency 5 returned p50 1002.86 ms, p95 1575.45 ms and 4.676 requests/s, including 100 sold-out responses. The server was local and the separate test database was remote Neon. This historical workload was not remeasured for the release and is not hosted capacity. |
| S3-03 / LR-T12 | The pre-deployment security review patched Next.js and `@next/env` to 16.4.3 and recorded checks. Its audit was point-in-time evidence; no new dependency audit was run for this documentation review. |
| S3-04 / LR-T06 | The public candidate, configuration boundaries, readiness and recovery instructions are documented. This review confirms the current deployment and journey. Provider rollback and database restore were not executed; Preview database isolation remains unverified. |
| S3-05 / LR-T12 | The existing bounded hosted security probe passed again at this release, using a real ticket owned by a different guest. |
| S3-06 / LR-T03 | The released revision passed the full existing CI regression, including persisted concurrency and application-failure recovery evidence above. |
| S3-07 / LR-T07 | Architecture, decisions, results, setup and the demonstration script are merged and linked from the README. The owner's ability to explain the design has not been assessed by this review. |
| S3-REV | Release identity, current automated/hosted results, sprint outcome review and engineering retrospective are recorded here. Owner feedback was requested; the owner said none was available and selected an evidence-based engineering retrospective. |

Sprint exit evidence includes the hosted main flow, isolated failure flows, exact revision/environment/workload, known limitations and [fresh-checkout instructions](README.md#run-from-a-fresh-checkout). A clean-checkout exercise was previously performed on revision `a42dce9`; its result is documented separately in the README and is not represented as a new exercise on `d6dde43`. The plan of three five-day sprints and four hours per day remains an estimate; reported-day/hour fields do not establish actual effort or schedule variance.

## Engineering retrospective

### What worked

The database remained the authority for inventory, ownership and operation identity. Three contention rounds reconciled every entitlement, while replay and recovery preserved the original result across application restarts. Keeping those responsibilities in one application with explicit SQL transactions made the correctness argument and its tests inspectable without another service or queue.

Carrying the same ownership/origin probe through the hosted deployment connected local/CI guarantees to observable HTTPS behavior. Recording the actual deployment revision prevented the earlier S3-06 success from being assumed to cover a later release. The README now gives a visitor a direct route from the demo to architecture, commands, results and the demo script.

### What should improve

Empty evidence fields and broadly recorded Done statuses leave a gap between planning and acceptance. S3-01's engineering walkthrough did not supply owner feedback, and documented rollback steps did not prove an executed provider rollback. Future closure should state those distinctions when the task is completed, rather than reconstruct them at the end of a sprint.

Evidence capture needs verification too. The requested browser sizes did not take effect in this review; measuring the actual viewport prevented a false responsive-test claim. Short-lived CI artifacts and ignored local files also need a durable summary of the essential results alongside shared documentation.

The measured baseline is consistent with serialization on the event row and possible pool waiting, but it does not isolate all latency causes or measure the hosted service. Successful correctness tests justify the selected ticket model; they do not justify production-scale performance claims or adding infrastructure without a new measured need.

### Follow-up actions

These use existing backlog IDs; no new feature work or tracker update is authorized by this list.

| Action | Existing scope | Completion evidence |
| --- | --- | --- |
| Complete an owner-led mobile/desktop and keyboard walkthrough, including unknown outcome → reload → check; record actual feedback and any fixes. | LR-T04 / S3-01 | Owner observations and verified follow-up, rather than an engineering check attributed to the owner. |
| If executed recovery acceptance is required, plan a safe rehearsal using independently verified disposable infrastructure; verify current rollback target compatibility and database restore behavior. | LR-T06 / S3-04 | Actual target/revision, procedure and recovered state. Do not exercise destructive recovery on the shared demo or an unverified Preview database. |
| At the next authorized tracker update, attach evidence and distinguish recorded status from verified acceptance; report actual remaining effort when known. | S3-REV and existing task rows | Evidence links and honest remaining-work entries. No reconstructed hours. |
| Before another presentation, recheck health, sale window and available inventory; verify any later deployed revision. | LR-T06 / LR-T07 | Current smoke/security evidence and an explanation if the fixed sale window has closed or tickets are sold out. Do not replenish the active demo to stage success. |
| Optimize or expand architecture only after a new workload identifies the problem. | LR-T09; LR-T08 and LR-US13 remain Future | Comparable before/after measurements for an explicitly selected later task. Holds, cancellation, payments and analytics remain outside this release. |

These are engineering observations, not invented owner feedback, usability approval or evidence of validated user demand.

## Presentation and recovery handoff

Use the [README demo script](README.md#demo-script) for event → review → confirm → reload → history → original ticket. Each intentional confirmation consumes one shared ticket. Explain same-browser access and why an unknown outcome must retain its original operation identity. Show the CI results above for contention, rollback and committed response loss; perform fault injection only in a dedicated disposable test environment.

For an outage, use the [release operations instructions](README.md#release-candidate-operations-s3-04) to check health, configuration, connectivity and migrations without revealing secrets. Inspect the actual previous deployment and compatibility before any authorized rollback. Application rollback does not restore database contents. Do not reset the active demo or replace an unknown operation with a new booking.

For a future authorized Evidence / Done output update, the following text summarizes this review without claiming owner acceptance:

> S3-REV engineering release review: production d6dde43665adfd2a2f8929545e3ea192e7fd5ff0 verified 2026-11-06. CI 42200310575 passed 220 unit/contract and 41 integration tests, 3 concurrency rounds, build/HTTP and 3 failure scenarios. Hosted booking/reload/history/reopen and all 12 security checks passed; one demo ticket consumed, no reset. Review and retrospective: SPRINT_3_REVIEW.md. Owner usability feedback and executed provider rollback/database restore remain unverified. No actual-effort claim or tracker status change.
