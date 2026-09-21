import { describe, expect, it } from 'vitest';
import { parse, recordKey } from '../src/sources.js';

describe('source contracts', () => {
  /** The alias is only safe if it preserves the idempotency business key. */
  it('adapts the documented ad-spend rename without changing its business key', () => {
    const oldRow = parse('ad_spend', 'date,campaign_id,platform,spend\n2026-01-01,c1,meta,12.20\n').rows[0];
    const newRow = parse('ad_spend', 'date,campaign_id,platform,cost_usd\n2026-01-01,c1,meta,12.20\n').rows[0];
    expect(recordKey('ad_spend', oldRow)).toBe(recordKey('ad_spend', newRow));
  });
  /** Unrecognised contracts must be quarantined instead of silently producing bad metrics. */
  it('quarantines an unrecognised order contract', () => {
    expect(() => parse('orders', 'order_id,created_at,total\no1,2026-01-01,10\n')).toThrow(/schema drift/);
  });
  /** CSV parsing must not corrupt valid quoted source values. */
  it('supports a quoted comma in CSV payloads', () => {
    expect(parse('orders', 'order_id,created_at,channel,gross,currency,customer_email\no1,2026-01-01T00:00:00Z,"social,paid",10,USD,a@b.c\n').rows).toHaveLength(1);
  });
});
