# Tenant-safe ingestion exercise

This is a deliberately small TypeScript/Postgres ingestion service. It prioritises
replay safety, auditable source contracts, tenant isolation in every key, and an
honest missing-arrival signal over adding every possible model.

## Run from a clean checkout

Prerequisite: Node 22+ and Docker.

```powershell
npm install
docker compose up -d
npm run migrate
npm run ingest
npm run model
npm run status
npm test
```

`DATABASE_URL` may be set to use another Postgres database. All commands accept
`--tenant northwind`; ingestion also accepts `--source orders` and `--manifest path`.
For a replay demonstration, run `npm run ingest -- --tenant northwind --source orders
--fail-after-rows 100`, then run the same command without `--fail-after-rows`.
The first attempt is recorded as failed; the second inserts only the remaining
business keys. A completed identical file is skipped by SHA-256.

## What was found and how it is handled

- `northwind` orders overlap by 14 order IDs. `raw_records` has the tenant/source/
  business-key primary key, so overlap and a restart cannot double-count them.
- `ad_spend` changes from `spend` to `cost_usd`. This is an explicit, tested source
  contract alias; it is normalised in staging. Unknown or missing columns quarantine
  the artifact with the detected contract error. Raw valid rows are immutable JSONB.
- `lumen/ad_spend/batch_03.csv` is listed in the manifest but absent. Ingestion writes
  a `missing` run and `npm run status` reports it. The mart is still built, but the
  status output makes that incompleteness visible rather than pretending zeros are data.
- Late arrivals are inserted by their source key and `npm run model` atomically rebuilds
  that tenant's staging and daily mart from all raw data. Therefore already-reported
  days are revised; `computed_at` tells consumers when the revision landed.

Every business table and deduplication key includes `tenant_id`, and modelling is
executed per tenant inside one transaction. Adding a client is configuration only:
add its slug and enabled source list to `config/tenants.json`, and supply its manifest
entries/files. There is no client-name branch or client-specific schema.

## Scope deliberately left out

The brief calls for orders, email events, and ad spend. The supplied materials also
contain `refunds` and a finance summary; they are intentionally not ingested. Net
revenue cannot be modelled responsibly until the client confirms refund accounting
(refund date versus order date, partial refunds, FX, and corrections). Treating it as
finished would make the daily numbers less trustworthy. The next slice would add a
refund source contract and an immutable revenue-adjustment mart, then introduce a
published-period/revision ledger and alert delivery (the current status command is the
operational signal, not an external notification system).

Other production work intentionally deferred: object-store receipts and file naming
identity, row-level security/tenant-scoped database roles, data-quality thresholds,
and orchestration/retries. The primary keys still make retries safe today; RLS is the
first hardening step before exposing this database to tenant-facing users.

---

# Deep dive fixtures

Four sources for two tenants, delivered the way exports actually land: a
sequence of batch files per source, one format per source.

- `orders/`        CSV, one row per order
- `email_events/`  NDJSON, one JSON object per line
- `ad_spend/`      CSV, daily spend per campaign
- `refunds/`       CSV, one row per refund

`manifest.json` lists every batch the set is supposed to contain, with the
window each one covers. `<tenant>/finance_summary.csv` is what the client
reports they earned, by day.

These fixtures contain the failures described in the brief. They are there
on purpose and they are not all obvious. Some of what you find cannot be
solved from the data at all; the brief says what to do about those. Reading
all of it before you start building is time well spent.
