/**
 * Load the repo-root .env, for scripts.
 *
 * Import for the side effect, before anything reads process.env:
 *
 *     import './env.js';
 *
 * Same reasoning as the worker and the API (ADR 010): a process that depends on the shell that
 * happened to start it fails in a way that looks like something else. `scripts/accept.ts`
 * without DATABASE_URL reports a SASL error from deep inside pg, which reads as a database
 * problem rather than a missing variable. Values already in the environment win.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
