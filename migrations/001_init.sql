-- Tenant is part of every data identity; this is the primary isolation boundary.
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
-- An immutable operational receipt for every attempted artifact delivery.
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, source text NOT NULL,
  artifact_path text NOT NULL, artifact_sha256 text, status text NOT NULL CHECK(status IN ('running','completed','failed','missing','quarantined')),
  rows_seen integer NOT NULL DEFAULT 0, rows_inserted integer NOT NULL DEFAULT 0, error text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS ingestion_runs_lookup ON ingestion_runs(tenant_id, source, artifact_path, status);
-- Original payloads are retained for audit and replay. The composite primary key
-- is the idempotency boundary: a tenant-local source business key is inserted once.
CREATE TABLE IF NOT EXISTS raw_records (
  tenant_id uuid NOT NULL REFERENCES tenants, source text NOT NULL, record_key text NOT NULL, payload jsonb NOT NULL,
  artifact_sha256 text NOT NULL, first_run_id uuid NOT NULL REFERENCES ingestion_runs, ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source, record_key)
);
-- Typed, rebuildable projections. They are never the system of record.
CREATE TABLE IF NOT EXISTS stg_orders (tenant_id uuid NOT NULL REFERENCES tenants, order_id text NOT NULL, created_at timestamptz NOT NULL, channel text NOT NULL, gross numeric(18,2) NOT NULL, currency text NOT NULL, customer_email text, PRIMARY KEY(tenant_id, order_id));
CREATE TABLE IF NOT EXISTS stg_email_events (tenant_id uuid NOT NULL REFERENCES tenants, event_id text NOT NULL, event_type text NOT NULL, email text NOT NULL, campaign_id text NOT NULL, occurred_at timestamptz NOT NULL, PRIMARY KEY(tenant_id, event_id));
CREATE TABLE IF NOT EXISTS stg_ad_spend (tenant_id uuid NOT NULL REFERENCES tenants, spend_date date NOT NULL, campaign_id text NOT NULL, platform text NOT NULL, spend numeric(18,2) NOT NULL, PRIMARY KEY(tenant_id, spend_date, campaign_id, platform));
-- Consumer-facing daily aggregate; `computed_at` exposes revisions caused by late arrivals.
CREATE TABLE IF NOT EXISTS mart_daily_performance (tenant_id uuid NOT NULL REFERENCES tenants, day date NOT NULL, gross_revenue numeric(18,2) NOT NULL, ad_spend numeric(18,2) NOT NULL, email_events integer NOT NULL, computed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id, day));
