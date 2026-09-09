import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities/index.js';

function loadRootEnv(): void {
  const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (!existsSync(envFile)) return;
  process.loadEnvFile(envFile);
}

loadRootEnv();

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
