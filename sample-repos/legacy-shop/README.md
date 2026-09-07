# legacy-shop

Order management backend. Originally written in 2015 against an in-house
VMS-era payment gateway, partially modernized between 2019 and 2023.

**Status:** production workloads still run on this code. Be careful.

## Run

    node src/app.js

The server listens on `PORT` (default 3001... yes, 3001, the load balancer
in front expects it — do not change without ops sign-off, see `src/config/config.js`).

## Test

    node --test tests/

## Modules

- `src/app.js` — HTTP entrypoint, hand-rolled router (no framework on purpose,
  the 2015 import could not have dependencies — see docs/architecture.md)
- `src/routes/` — request handlers (products, orders, auth)
- `src/services/` — business logic
- `src/db/` — JSON-file persistence layer
- `src/lib/legacyIds.js` — integer ID generation, base offset 1000 kept for
  compatibility with the old reporting system

## Known issues (do NOT "fix" casually)

1. **Payment refunds have a race condition** under concurrent calls. Known
   since 2021, tracked informally. A rewrite was attempted twice and rolled
   back both times (see git history). Any fix must keep the legacy gateway
   retry behavior described in `src/services/paymentService.js`.
2. The persistence layer uses synchronous `fs` calls. This is deliberate —
   see the comment in `src/db/database.js`.
3. IDs are sequential integers starting at 1000. The reporting team's ETL
   assumes this.

## Conventions

- No external runtime dependencies (2015 constraint, kept ever since).
- All money values are integer cents.
- Route handlers validate input manually.
