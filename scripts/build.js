import * as esbuild from 'esbuild';

const commonOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
};

await Promise.all([
  esbuild.build({
    ...commonOptions,
    entryPoints: ['src/main.ts'],
    outfile: 'dist/daemon.mjs',
  }),
  esbuild.build({
    ...commonOptions,
    entryPoints: ['src/orchestrator.ts'],
    outfile: 'dist/orchestrator.mjs',
  }),
  esbuild.build({
    ...commonOptions,
    entryPoints: ['src/worker-entry.ts'],
    outfile: 'dist/worker-entry.mjs',
  }),
]);

console.log('Built dist/daemon.mjs, dist/orchestrator.mjs, dist/worker-entry.mjs');
