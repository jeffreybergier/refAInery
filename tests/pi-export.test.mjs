import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../source/backend/storage.ts';
import { exportSession } from '../source/backend/pi.ts';
import { piExportDocument } from '../source/backend/pi-export.ts';
import { nativeExport, withLegacyFallback } from './helpers/pi-export.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'refainery-export-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,...await nativeExport(root,'<img src="https://invalid.example/leak" onerror="window.pwned=1">\n\nOffline **Pi export**.')};
}

test('publishes the actual Pi HTML export byte-for-byte, without reading messages',async(t)=>{
  const f=await fixture(t),store=new Store(f.root);
  await mkdir(store.path('runs/run-offline/pi-private'),{recursive:true});
  const result=await exportSession(store,'runs/run-offline',{
    exportToHtml:f.exportToHtml,sessionFile:f.sessionFile,
    get messages(){throw Error('Must not synthesize a transcript')},
  },'orchestrator');
  assert.equal(result.state,'saved');
  assert.equal(await readFile(store.path('runs/run-offline',result.path),'utf8'),f.html);
  await assert.rejects(exportSession(store,'runs/run-offline',f,'orchestrator'));
});

test('native Pi scripts get pinned hashes and an opaque-origin, network-disabled sandbox',async(t)=>{
  const {html}=await fixture(t),doc=piExportDocument(html);
  assert.equal(doc.content,html);
  assert.match(doc.policy,/^sandbox allow-scripts allow-downloads;/);
  assert.match(doc.policy,/script-src 'sha256-/);
  assert.equal((doc.policy.match(/'sha256-/g)??[]).length,7);
  assert.match(doc.policy,/script-src-attr 'unsafe-hashes'/);
  assert.match(doc.policy,/connect-src 'none'/);
  assert.doesNotMatch(doc.policy,/allow-same-origin|allow-popups|unsafe-eval|script-src 'unsafe-inline'/);
  const another=await nativeExport((await fixture(t)).root,'Different session contents');
  assert.equal(piExportDocument(another.html).policy,doc.policy);
});

test('legacy display repair returns original native bytes without changing saved artifacts',async(t)=>{
  const {html}=await fixture(t),legacy=withLegacyFallback(html);
  assert.equal(piExportDocument(legacy).content,html);
  assert.match(legacy,/Saved Pi session/);
});

test('unknown, altered, injected, or invalid-data exports never gain script permission',async(t)=>{
  const {html}=await fixture(t);
  for(const altered of [
    '<html><script>alert(1)</script></html>',
    html.replace('<body>','<body><script>window.pwned=1</script>'),
    html.replace('const globalStats','const attackerGlobalStats'),
    html.replace('<style>','<style></style><script>window.pwned=1</script><style>'),
    html.replace(/(<script id="session-data" type="application\/json">)[^<]+/,'$1invalid'),
    html.replace(/(<script id="session-data" type="application\/json">)[^<]+/,'$1e30='),
  ]) assert.equal(piExportDocument(altered),null);
});
