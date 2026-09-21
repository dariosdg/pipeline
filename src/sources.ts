import { createHash } from 'node:crypto';
import { parseCsv } from './csv.js';

/** Sources intentionally in scope for this delivery. */
export const SOURCES = ['orders', 'email_events', 'ad_spend'] as const;
/** A source identifier accepted by the ingestion contract. */
export type Source = typeof SOURCES[number];
/** Original source row, preserved without business transformations. */
export type Raw = Record<string, unknown>;
/** Parsed rows and their observed field signature for run audit output. */
export type ParsedFile = { rows: Raw[]; schema: string };

/** Fails closed when a required field has disappeared from a source contract. */
const assertFields = (row: Raw, required: string[], source: Source) => {
  const actual = Object.keys(row).sort();
  const missing = required.filter((key) => !(key in row));
  if (missing.length) throw new Error(`${source} schema drift: missing ${missing.join(', ')} (received: ${actual.join(', ')})`);
};

/** Fails closed for unrecognised additions so schema drift is visible to operators. */
const assertOnlyFields = (row: Raw, allowed: string[], source: Source) => {
  const unexpected = Object.keys(row).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${source} schema drift: unexpected ${unexpected.join(', ')}`);
};

/**
 * Parses and validates one artifact against its explicit source contract.
 *
 * `ad_spend` has one deliberate compatibility rule: `spend` and `cost_usd`
 * are accepted because the fixtures demonstrate that documented rename. Any
 * other change throws and the caller records the artifact as quarantined.
 * @param source Source contract to apply.
 * @param contents Complete artifact content.
 */
export function parse(source: Source, contents: string): ParsedFile {
  let rows: Raw[];
  if (source === 'email_events') {
    rows = contents.split(/\r?\n/).filter(Boolean).map((line, i) => { try { return JSON.parse(line) as Raw; } catch { throw new Error(`email_events line ${i + 1} is not JSON`); } });
    rows.forEach((row) => { assertFields(row, ['event_id', 'type', 'email', 'campaign_id', 'occurred_at'], source); assertOnlyFields(row, ['event_id', 'type', 'email', 'campaign_id', 'occurred_at'], source); });
  } else {
    rows = parseCsv(contents);
    const fields = source === 'orders' ? ['order_id', 'created_at', 'channel', 'gross', 'currency', 'customer_email'] : ['date', 'campaign_id', 'platform'];
    rows.forEach((row) => { assertFields(row, fields, source); assertOnlyFields(row, source === 'orders' ? fields : [...fields, 'spend', 'cost_usd'], source); });
    if (source === 'ad_spend' && rows.some((row) => !('spend' in row) && !('cost_usd' in row))) throw new Error('ad_spend schema drift: expected spend or cost_usd');
  }
  const schema = [...new Set(rows.flatMap(Object.keys))].sort().join(',');
  return { rows, schema };
}

/**
 * Returns the tenant-local business identity used for raw idempotency.
 * The database primary key additionally includes `tenant_id` and `source`,
 * preventing a retry or overlapping delivery from double-counting a record.
 */
export function recordKey(source: Source, row: Raw): string {
  if (source === 'orders') return String(row.order_id);
  if (source === 'email_events') return String(row.event_id);
  return `${row.date}|${row.campaign_id}|${row.platform}`;
}

/** Produces an immutable content identity for completed-artifact fast-path checks. */
export const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
