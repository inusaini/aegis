# Architecture Notes (legacy-shop)

Last meaningfully updated: 2023-11.

## Overall shape

    HTTP request
        |
    src/app.js  (hand-rolled router)
        |
    src/routes/*      (parse + validate input)
        |
    src/services/*    (business logic, money in integer cents)
        |
    src/db/database.js (JSON file persistence, synchronous IO)
        |
    data/*.json on disk

## The payment gateway situation

`paymentService.js` talks to a legacy payment gateway that has been
deprecated by the vendor but is still the only integration our merchant
account allows. The gateway:

- requires a retry (INC-2231) — the `setTimeout` retry block must stay,
- has no idempotency support of its own,
- occasionally takes 40-80ms to ack, which is where the refund race
  condition comes from.

Two attempts to replace the gateway (2021 "gateway-v2" branch, 2023
"payproc" spike) were abandoned. Do not start a third attempt inside a
bug fix.

## Why synchronous IO in the DB layer

The 2016 NFS mount on the old Solaris host silently truncated async
writes. We moved to sync `readFileSync`/`writeFileSync` and never had
corruption again. It's ugly, it's slow, it stays. If throughput ever
matters, migrate to a real database — but that is a project, not a patch.

## ID scheme

`src/lib/legacyIds.js` hands out sequential integers starting at 1000
because the reporting ETL rejects IDs below 1000. Treat as frozen
contract.

## Testing

`node --test tests/`. Tests run against temp copies of the JSON data
files; they never touch production data files.
