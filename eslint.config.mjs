import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/coverage/**', 'data/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // the spec §15 — no `any`; use `unknown` and narrow.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // the spec §4.1 rule 4 — only the LLM adapters may import `openai`.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/llm/src/adapters/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'openai',
              message:
                'Import the LlmProvider interface from @han/llm instead. Only packages/llm/src/adapters/ may import the openai SDK (the spec §4.1).',
            },
          ],
        },
      ],
    },
  },
  {
    // the spec §9.1 — Temporal workflow code is deterministic and sandboxed.
    files: ['apps/worker/src/workflows/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Workflow code cannot do I/O — move it to an activity.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Use workflow.now() — workflow code must be deterministic.' },
        { object: 'Math', property: 'random', message: 'Use workflow.uuid4() — workflow code must be deterministic.' },
        { object: 'crypto', property: 'randomUUID', message: 'Use workflow.uuid4() — workflow code must be deterministic.' },
      ],
    },
  },
);
