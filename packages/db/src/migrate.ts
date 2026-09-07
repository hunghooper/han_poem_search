/**
 * Migration runner: Drizzle-generated DDL first, then the raw-SQL custom migrations that
 * Drizzle cannot express (the pg_bigm operator classes — ADR 001).
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Load the repo-root .env before reading DATABASE_URL — same reasoning as the worker and the
 * API (ADR 010). A migration runner that only works from one particular shell is a migration
 * runner that fails at the worst moment.
 */
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
    console.log('drizzle migrations applied');

    const customDir = join(migrationsFolder, 'custom');
    const files = (await readdir(customDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(customDir, file), 'utf8');
      await pool.query(sql);
      console.log(`custom migration applied: ${file}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
