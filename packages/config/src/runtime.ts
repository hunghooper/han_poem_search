/**
 * Load the committed runtime configuration.
 *
 * Resolved from THIS module rather than from cwd: services start under `pnpm --filter`, whose
 * cwd is the package directory, and a cwd-relative path silently finds nothing — the same bug
 * that made config/pricing.yaml unreadable for the whole of Phase 3.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { RuntimeConfigSchema, type RuntimeConfig } from '@han/shared/runtime-config';

export const RUNTIME_CONFIG_PATH = fileURLToPath(
  new URL('../../../config/runtime.yaml', import.meta.url),
);

export function loadRuntimeConfig(path: string = process.env.RUNTIME_CONFIG_FILE ?? RUNTIME_CONFIG_PATH): RuntimeConfig {
  const parsed = RuntimeConfigSchema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    // Falling back to defaults here would start the process with settings nobody chose, and
    // the operator would only find out from behaviour. Fail at boot with the reason.
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid runtime config at ${path}:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
