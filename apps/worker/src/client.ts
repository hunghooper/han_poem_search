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

export async function runAgentWorkflow(input: AgentRunInput): Promise<AgentRunOutput> {
  const c = await getTemporalClient();
  const handle = await c.workflow.start('agentRun', {
    taskQueue: TASK_QUEUE,
    workflowId: `agent-${input.runId}`,
    args: [input],
    workflowExecutionTimeout: '10 minutes',
  });
  return handle.result();
}
