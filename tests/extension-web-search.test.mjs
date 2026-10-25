import assert from 'node:assert/strict';
import test from 'node:test';
import disabled, { createWebSearchExtension } from '../source/extensions/web-search.ts';

const openrouter = { provider: 'openrouter', api: 'openai-completions' };
const openai = { provider: 'openai', api: 'openai-responses' };
function hook(factory) {
  let handler;
  factory({ on(event, callback) {
    assert.equal(event, 'before_provider_request');
    handler = callback;
  } });
  return (payload, model = openrouter) =>
    handler({ payload }, { model }) ?? payload;
}
const types = (payload) => (payload.tools ?? []).map((tool) => tool.type);

test('production-style tool lists permit search; only worker has local tools/fetch', () => {
  for (const id of ['worker', 'orchestrator']) {
    const agent = { availableTools: id === 'worker'
      ? ['read', 'write', 'edit', 'bash', 'web_search', 'web_fetch'] : ['web_search'] };
    assert.ok(agent.availableTools.includes('web_search'));
    const result = hook(createWebSearchExtension(agent.availableTools, openrouter))({});
    assert.deepEqual(types(result), id === 'worker'
      ? ['openrouter:web_search', 'openrouter:web_fetch'] : ['openrouter:web_search']);
    for (const tool of ['read', 'write', 'edit', 'bash']) {
      assert.equal(agent.availableTools.includes(tool), id === 'worker');
    }
  }
});

test('search and fetch permissions are independent', () => {
  const run = hook(createWebSearchExtension(['web_fetch'], openrouter));
  assert.deepEqual(types(run({})), ['openrouter:web_fetch']);
});

test('OpenAI Responses supports only the inherited native search mapping', () => {
  const run = hook(createWebSearchExtension(['web_search'], openai));
  assert.deepEqual(types(run({}, openai)), ['web_search']);
  assert.throws(() => createWebSearchExtension(['web_fetch'], openai), /Unsupported/);
  assert.throws(() => createWebSearchExtension(['web_search'], {
    ...openai, api: 'openai-completions',
  }), /Unsupported/);
});

test('unsupported transports and duplicate allowlist entries fail at construction', () => {
  assert.throws(() => createWebSearchExtension(['web_search'], {
    provider: 'other', api: 'other',
  }), /Unsupported/);
  assert.throws(() => createWebSearchExtension(['web_search', 'web_search'], openrouter),
    /Duplicate/);
});

test('default loading grants nothing and removes recognized native web tools', () => {
  const run = hook(disabled);
  const local = { type: 'function', function: { name: 'read' } };
  assert.deepEqual(run({ tools: [local, { type: 'web_search' },
    { type: 'openrouter:web_search' }, { type: 'openrouter:web_fetch' }] }),
  { tools: [local] });
});

test('preserves local tools/options, removes denied web types and duplicates', () => {
  const local = { type: 'function', function: { name: 'read' } };
  const search = { type: 'openrouter:web_search', customOption: 'retained' };
  const payload = { model: 'example', stream: true,
    tools: [local, search, { ...search }, { type: 'openrouter:web_fetch' }] };
  const before = structuredClone(payload);
  const run = hook(createWebSearchExtension(['web_search'], openrouter));
  const result = run(payload);
  assert.deepEqual(payload, before);
  assert.deepEqual(result, { model: 'example', stream: true, tools: [local, search] });
  assert.equal(run(result), result);
});

test('model changes/missing model do not receive approved capabilities', () => {
  const run = hook(createWebSearchExtension(['web_search'], openrouter));
  for (const model of [openai, null, { ...openrouter, api: 'changed' }]) {
    assert.deepEqual(types(run({ tools: [{ type: 'openrouter:web_search' }] }, model)), []);
  }
});

test('allowlists and sessions are isolated from later caller mutation', () => {
  const allowed = ['web_search'];
  const model = { ...openrouter };
  const run = hook(createWebSearchExtension(allowed, model));
  allowed.push('web_fetch');
  model.provider = 'other';
  const first = run({});
  first.tools[0].type = 'changed';
  assert.deepEqual(types(run({})), ['openrouter:web_search']);
  assert.deepEqual(hook(createWebSearchExtension([], openrouter))({}), {});
});

test('malformed payloads are not rewritten; extension does not validate transport', () => {
  const run = hook(createWebSearchExtension(['web_search'], openrouter));
  for (const payload of [null, [], 'invalid', { tools: 'invalid' }]) {
    assert.equal(run(payload), payload);
  }
});
