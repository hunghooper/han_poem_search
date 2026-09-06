import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema } from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(connectionString: string, poolMax = 10) {
  const pool = new pg.Pool({ connectionString, max: poolMax });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
