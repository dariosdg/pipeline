import { Pool, PoolClient } from 'pg';

/** Shared connection pool for the pipeline database. */
export const db = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://pipeline:pipeline@localhost:5432/pipeline' });

/**
 * Executes work in a database transaction and guarantees that the checked-out
 * connection is released. Callers should keep the callback limited to one
 * logical unit of work so a failed model rebuild cannot expose partial data.
 */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
     await client.query('BEGIN');
     const value = await fn(client); 
     await client.query('COMMIT'); 
     return value;
  }catch (error) {
     await client.query('ROLLBACK');
     throw error; 
  }finally {
     client.release(); 
  }
}
