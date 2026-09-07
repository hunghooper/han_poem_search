/**
 * Workflow entry point. The worker bundles everything reachable from this file into the
 * sandbox, so nothing here may import a module that touches the network, the database or the
 * filesystem — including transitively.
 */

export { agentRun } from './agent-run.js';
