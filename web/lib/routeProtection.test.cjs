const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createRouteMatcher } = require('@clerk/nextjs/server');
const { NextRequest } = require('next/server');

// Execute the real proxy with Clerk's real matcher. Only session verification
// is injected, avoiding credentials or calls to a live identity provider.
const source = fs.readFileSync(require.resolve('../proxy.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exportsObject = {};
vm.runInNewContext(compiled, {
  exports: exportsObject,
  require(name) {
    assert.equal(name, '@clerk/nextjs/server');
    return { createRouteMatcher, clerkMiddleware: (handler) => handler };
  },
});

test('dashboard, user APIs, and unlisted cron-like routes require authentication', async () => {
  for (const path of ['/dashboard', '/dashboard/settings', '/api/brokers', '/api/cron/new-job', '/api/cron-admin', '/api/cron/auto-ai-trading/extra']) {
    let checks = 0;
    await exportsObject.default({ protect: async () => { checks++; } }, new NextRequest(`https://example.test${path}`));
    assert.equal(checks, 1, path);
  }
});

test('a rejected session cannot continue through a protected route', async () => {
  const denied = new Error('session rejected');
  await assert.rejects(exportsObject.default({ protect: async () => { throw denied; } }, new NextRequest('https://example.test/dashboard')), denied);
});

test('public entry points and each existing cron retain their intended access path', async () => {
  const paths = ['/', '/api/health', '/sso-callback',
    '/api/cron/edge-learning-refresh', '/api/cron/oanda-transaction-sync',
    '/api/cron/auto-ai-trading', '/api/cron/active-trade-management',
    '/api/cron/auto-ai-trading-extended', '/api/cron/engine-learning-backfill'];
  for (const path of paths) {
    await exportsObject.default({ protect: async () => assert.fail(path) }, new NextRequest(`https://example.test${path}`));
  }
});
