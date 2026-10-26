import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, requestIdentity, localIdentity } from '../source/backend/storage.ts';
import { enqueue } from '../source/backend/workflow.ts';
import { Sandbox, createWorkspace } from '../source/backend/sandbox.ts';
import { instructions, resolveWorkspaceInstructions } from '../source/agents/shared.ts';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'refainery-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('request IDs use two UUID sections; local numbering grows without truncation', () => {
  assert.match(requestIdentity(), /^request-[0-9a-f]{8}-[0-9a-f]{4}$/);
  assert.equal(localIdentity('task', 1), 'task-001');
  assert.equal(localIdentity('attempt', 2), 'attempt-002');
  assert.equal(localIdentity('task', 1000), 'task-1000');
});

test('requests own separate workspaces, and existing workspaces fail closed', async t => {
  const root = await setup(t), store = new Store(root);
  const first = await enqueue(store, 'First request');
  const second = await enqueue(store, 'Second request');
  assert.notEqual(first.id, second.id);
  const firstPath = store.path('workspaces', first.id);
  const secondPath = store.path('workspaces', second.id);
  await createWorkspace(firstPath);
  await createWorkspace(secondPath);
  await writeFile(join(firstPath, 'artifact.txt'), 'First request');
  await assert.rejects(readFile(join(secondPath, 'artifact.txt')), { code: 'ENOENT' });
  await assert.rejects(createWorkspace(firstPath), { code: 'EEXIST' });
  assert.equal(await readFile(join(firstPath, 'artifact.txt'), 'utf8'), 'First request');
  const sandbox = new Sandbox('test', firstPath);
  assert.equal(sandbox.workspace, firstPath);
  assert.equal(sandbox.workerWorkspace, `/workspace/${first.id}`);
  const guidance = resolveWorkspaceInstructions(instructions, sandbox.workerWorkspace);
  assert.ok(guidance.includes(`Workspace: ${sandbox.workerWorkspace}`));
  assert.ok(!guidance.includes('{{ CURRENT WORKING DIRECTORY }}'));
});

test('workspace placeholder replacement is literal, repeatable and single-pass', () => {
  const marker = '{{ CURRENT WORKING DIRECTORY }}';
  assert.ok(instructions.includes(marker));
  const workspace = `/workspace/$&-${marker}`;
  assert.equal(resolveWorkspaceInstructions(`${marker}\n${marker}`, workspace),
    `${workspace}\n${workspace}`);
  assert.equal(resolveWorkspaceInstructions('No marker', workspace), 'No marker');
});

test('workspace allocation does not adopt a pre-existing symlink', async t => {
  const root = await setup(t);
  await mkdir(join(root, 'other'));
  await symlink(join(root, 'other'), join(root, 'request'));
  await assert.rejects(createWorkspace(join(root, 'request')), { code: 'EEXIST' });
});
