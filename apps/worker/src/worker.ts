/**
 * The Temporal worker — the spec §2, Phase 4.
 *
 * Runs workflow code in a sandbox and activities in this process. Killing it mid-run loses
 * nothing: the workflow's history lives in Temporal, and a restarted worker replays it and
 * carries on from where it stopped. That is the §16 Phase 4 acceptance criterion, and the
 * whole reason the loop moved here.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';

/**
 * Load the repo-root .env before anything reads process.env.
 *
 * A worker that inherits its configuration from whichever shell happened to start it is a
 * worker that comes back from a restart subtly different from the one that died — which is
 * exactly the case Phase 4 exists to survive. This was found the hard way: a restarted worker
 * had no gateway key, every reasoning call failed, and the run reported "budget exhausted".
 * Values already in the environment win, so deployments that set real variables are untouched.
 */
function loadRootEnv(): void {
  const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (!existsSync(envFile)) return;
  process.loadEnvFile(envFile);
}

loadRootEnv();

/**
 * Resolve the workflow bundle entrypoint.
 *
 * Temporal's bundler stats this path on disk, and the whole project runs through tsx — so the
 * file that exists is index.ts, not the index.js an ESM specifier would name. Preferring .ts
 * and falling back to .js keeps it working both under tsx and against a built dist.
 */
function workflowsPath(): string {
  const ts = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));
  return existsSync(ts) ? ts : fileURLToPath(new URL('./workflows/index.js', import.meta.url));
}

const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'search';

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: workflowsPath(),
    activities,
    // One workflow task at a time keeps replay ordering easy to reason about while the agent
    // is the only workflow; raise it when there is a second.
    maxConcurrentWorkflowTaskExecutions: 10,
    maxConcurrentActivityTaskExecutions: 20,
  });

  console.log(`worker listening on ${address} · namespace ${namespace} · queue ${taskQueue}`);
  await worker.run();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
