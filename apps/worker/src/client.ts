/**
 * Client helpers for starting an agent run. Imported by the API, not by the worker.
 */

import { Client, Connection } from '@temporalio/client';
import type { AgentRunInput, AgentRunOutput } from './shared.js';

export const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'search';

let client: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (client) return client;
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  return client;
}

/**
 * Start an agent run and wait for it.
 *
 * The workflow id is the search run id, so a retry of the same search joins the existing
 * workflow rather than starting a second one — and so the run is findable in the Temporal UI
 * by the same id the trace and the event log use.
 */
export async function runAgentWorkflow(input: AgentRunInput): Promise<AgentRunOutput> {
  const c = await getTemporalClient();
  const handle = await c.workflow.start('agentRun', {
    taskQueue: TASK_QUEUE,
    workflowId: `agent-${input.runId}`,
    args: [input],
    // A generous ceiling above the agent's own wall clock: the workflow enforces §12 itself,
    // and this exists only so a wedged run cannot live forever.
    workflowExecutionTimeout: '10 minutes',
  });
  return handle.result();
}
