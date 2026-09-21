import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { db, tx } from './db.js';
import { parse, recordKey, sha256, type Source } from './sources.js';

/** A delivery expected by the client-provided manifest. */
type Batch = { tenant: string; source: Source; path: string; batch: number; covers_from: string; covers_to: string };

/** Manifest format used to distinguish missing expected artifacts from no delivery expectation. */
type Manifest = { batches: Batch[] };

/** Configuration-only tenant onboarding contract. */
type Config = { tenants: { slug: string; enabled_sources: Source[] }[] };

const root = process.cwd();

/** Returns the value immediately following a CLI option, if supplied. */
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };

/** Splits writes into independently committed batches, allowing a retry after a process crash. */
const chunks = <T>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, i * size + size));

/** Loads the tenants without introducing tenant-specific code paths. */
async function config(): Promise<Config> { return JSON.parse(await readFile(join(root, 'config/tenants.json'), 'utf8')); }

/** Ensures a tenant exists and returns its stable database identity. */
async function tenantId(slug: string): Promise<string> {
  const result = await db.query('INSERT INTO tenants(slug) VALUES($1) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id', [slug]);
  return result.rows[0].id;
}

/** Applies each SQL migration exactly once, with the migration receipt in the same transaction. */
async function migrate() {
  const files = (await readdir(join(root, 'migrations'))).filter((x) => x.endsWith('.sql')).sort();
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text primary key, applied_at timestamptz not null default now())');
  for (const name of files) {
    const exists = await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
    if (!exists.rowCount) await tx(async (client) => { await client.query(await readFile(join(root, 'migrations', name), 'utf8')); await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]); });
  }
  console.log(`Applied ${files.length} migration file(s).`);
}

/** Records an expected-but-unavailable or contract-incompatible artifact for operational status. */
async function markFailure(tenant: string, source: Source, path: string, status: 'missing' | 'quarantined', error: string) {
  const id = await tenantId(tenant);
  await db.query('INSERT INTO ingestion_runs(tenant_id,source,artifact_path,status,error,finished_at) VALUES($1,$2,$3,$4,$5,now())', [id, source, path, status, error]);
  console.error(`${tenant}/${source}/${path}: ${status}: ${error}`);
}

/**
 * Ingests one artifact into immutable raw storage.
 *
 * Completed identical content is skipped by hash. For a retry of a partially
 * failed run, `ON CONFLICT DO NOTHING` on the tenant/source/business-key
 * primary key retains already committed rows and inserts only the remainder.
 */
async function ingestBatch(batch: Batch, failAfter?: number) {
  const id = await tenantId(batch.tenant); let text: string;

  try { 
    text = await readFile(resolve(root, batch.path), 'utf8'); 
  }catch { 
    return markFailure(batch.tenant, batch.source, batch.path, 'missing', 'expected artifact is absent'); 
  }

  const hash = sha256(text);
  const done = await db.query("SELECT 1 FROM ingestion_runs WHERE tenant_id=$1 AND source=$2 AND artifact_sha256=$3 AND status='completed' LIMIT 1", [id, batch.source, hash]);
  
  if (done.rowCount) return console.log(`${batch.path}: already completed (same content)`);
  let parsed;
  try {
     parsed = parse(batch.source, text);
  }catch (error) {
     return markFailure(batch.tenant, batch.source, batch.path, 'quarantined', String(error));
  }

  const run = await db.query("INSERT INTO ingestion_runs(tenant_id,source,artifact_path,artifact_sha256,status) VALUES($1,$2,$3,$4,'running') RETURNING id", [id, batch.source, batch.path, hash]);
  const runId = run.rows[0].id as string; let inserted = 0; let seen = 0;
  try {
    for (const group of chunks(parsed.rows, 100)) {
      await tx(async (client) => {
        for (const row of group) {
          const result = await client.query('INSERT INTO raw_records(tenant_id,source,record_key,payload,artifact_sha256,first_run_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,source,record_key) DO NOTHING', [id, batch.source, recordKey(batch.source, row), JSON.stringify(row), hash, runId]);
          inserted += result.rowCount ?? 0; seen++;
        }
      });
      if (failAfter && seen >= failAfter) throw new Error(`intentional failure after ${seen} rows`);
    }
    await db.query("UPDATE ingestion_runs SET status='completed',rows_seen=$2,rows_inserted=$3,finished_at=now() WHERE id=$1", [runId, seen, inserted]);
    console.log(`${batch.path}: completed; ${seen} seen, ${inserted} new, schema [${parsed.schema}]`);
  } catch (error) {
    await db.query("UPDATE ingestion_runs SET status='failed',rows_seen=$2,rows_inserted=$3,error=$4,finished_at=now() WHERE id=$1", [runId, seen, inserted, String(error)]);
    throw error;
  }
}

/** Selects configured manifest batches and ingests them serially for clear run auditability. */
async function ingest() {
  const manifest: Manifest = JSON.parse(await readFile(arg('--manifest') ?? join(root, 'manifest.json'), 'utf8'));
  const cfg = await config(); const wantedTenant = arg('--tenant'); const wantedSource = arg('--source'); const failAfter = Number(arg('--fail-after-rows') ?? 0) || undefined;
  const configured = new Map(cfg.tenants.map((t) => [t.slug, new Set(t.enabled_sources)]));
  const selected = manifest.batches.filter((b) => (!wantedTenant || b.tenant === wantedTenant) && (!wantedSource || b.source === wantedSource) && configured.get(b.tenant)?.has(b.source));
  if (!selected.length) throw new Error('No manifest batches match enabled tenant/source configuration.');
  for (const batch of selected) await ingestBatch(batch, failAfter);
}

/**
 * Rebuilds a tenant's typed staging tables and daily mart in one transaction.
 * Full rebuilds make late arrivals revise historical days deterministically.
 */
async function model() {
  const wanted = arg('--tenant'); const cfg = await config();
  for (const tenant of cfg.tenants.filter((t) => !wanted || t.slug === wanted)) {
    const id = await tenantId(tenant.slug);
    await tx(async (client) => {
      await client.query('DELETE FROM stg_orders WHERE tenant_id=$1', [id]);
      await client.query('DELETE FROM stg_email_events WHERE tenant_id=$1', [id]);
      await client.query('DELETE FROM stg_ad_spend WHERE tenant_id=$1', [id]);
      await client.query('DELETE FROM mart_daily_performance WHERE tenant_id=$1', [id]);
      await client.query("INSERT INTO stg_orders SELECT tenant_id,payload->>'order_id',(payload->>'created_at')::timestamptz,payload->>'channel',(payload->>'gross')::numeric,payload->>'currency',payload->>'customer_email' FROM raw_records WHERE tenant_id=$1 AND source='orders'", [id]);
      await client.query("INSERT INTO stg_email_events SELECT tenant_id,payload->>'event_id',lower(payload->>'type'),payload->>'email',payload->>'campaign_id',(payload->>'occurred_at')::timestamptz FROM raw_records WHERE tenant_id=$1 AND source='email_events'", [id]);
      await client.query("INSERT INTO stg_ad_spend SELECT tenant_id,(payload->>'date')::date,payload->>'campaign_id',payload->>'platform',coalesce(payload->>'cost_usd',payload->>'spend')::numeric FROM raw_records WHERE tenant_id=$1 AND source='ad_spend'", [id]);
      // Use a non-keyword join alias; the physical mart column remains quoted as "day".
      await client.query("INSERT INTO mart_daily_performance(tenant_id,\"day\",gross_revenue,ad_spend,email_events) SELECT $1, days.metric_day,coalesce(o.gross,0),coalesce(a.spend,0),coalesce(e.events,0) FROM (SELECT created_at::date AS metric_day FROM stg_orders WHERE tenant_id=$1 UNION SELECT spend_date AS metric_day FROM stg_ad_spend WHERE tenant_id=$1 UNION SELECT occurred_at::date AS metric_day FROM stg_email_events WHERE tenant_id=$1) days LEFT JOIN (SELECT created_at::date AS metric_day,sum(gross) AS gross FROM stg_orders WHERE tenant_id=$1 GROUP BY 1) o USING(metric_day) LEFT JOIN (SELECT spend_date AS metric_day,sum(spend) AS spend FROM stg_ad_spend WHERE tenant_id=$1 GROUP BY 1) a USING(metric_day) LEFT JOIN (SELECT occurred_at::date AS metric_day,count(*)::integer AS events FROM stg_email_events WHERE tenant_id=$1 GROUP BY 1) e USING(metric_day)", [id]);
    });
    console.log(`${tenant.slug}: staging and mart rebuilt atomically (late records are included).`);
  }
}

/** Reports completed, missing, failed, and quarantined artifacts against manifest expectations. */
async function status() {
  const manifest: Manifest = JSON.parse(await readFile(arg('--manifest') ?? join(root, 'manifest.json'), 'utf8'));
  const cfg = await config();
  for (const tenant of cfg.tenants) for (const source of tenant.enabled_sources) {
    const expected = manifest.batches.filter((b) => b.tenant === tenant.slug && b.source === source).length;
    const result = await db.query("SELECT status,count(*)::int count FROM ingestion_runs r JOIN tenants t ON t.id=r.tenant_id WHERE t.slug=$1 AND r.source=$2 GROUP BY status", [tenant.slug, source]);
    const states = Object.fromEntries(result.rows.map((r) => [r.status, r.count]));
    console.log(`${tenant.slug.padEnd(10)} ${source.padEnd(14)} expected=${expected} completed=${states.completed ?? 0} missing=${states.missing ?? 0} failed=${(states.failed ?? 0) + (states.quarantined ?? 0)}`);
  }
}

const command = process.argv[2];
try {
   if (command === 'migrate') await migrate();
    else if (command === 'ingest') await ingest();
    else if (command === 'model') await model(); 
    else if (command === 'status') await status(); 
    else throw new Error('Use: migrate | ingest | model | status'); 
  }finally {
     await db.end(); 
  }
