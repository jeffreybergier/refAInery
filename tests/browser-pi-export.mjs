// Optional offline browser security/regression check. No keys or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { nativeExport } from './helpers/pi-export.mjs';
import { piExportDocument } from '../source/backend/pi-export.ts';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root=await mkdtemp(join(tmpdir(),'refainery-export-browser-'));
let browser,server;
try {
  const {html}=await nativeExport(root,'Offline **Pi export** verification.\n\n<img src="/probe" onerror="window.pwned=1"><script>window.pwned=1</script>');
  const doc=piExportDocument(html);assert.ok(doc);
  let probes=0;
  server=createServer((req,res)=>{
    if(req.url!=='/export') {probes++;res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':doc.policy});res.end(doc.content);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.violations=[];
    document.addEventListener('securitypolicyviolation',e=>window.violations.push(e.effectiveDirective));
  });
  await page.goto(origin+'/export');await page.waitForSelector('#messages .assistant-message');
  assert.match(await page.locator('#header-container h1').textContent(),/Session: offline-export/);
  assert.equal(await page.locator('#messages strong').textContent(),'Pi export');
  await page.locator('[data-filter="labeled-only"]').click();
  assert.equal(await page.locator('[data-filter="labeled-only"]').getAttribute('class'),'filter-btn active');
  // Pi retains the active leaf even when no other entries match the filter.
  assert.equal(await page.locator('.tree-node').count(),1);
  await page.locator('[data-filter="default"]').click();assert.equal(await page.locator('.tree-node').count(),2);
  const download=page.waitForEvent('download');
  await page.locator('.download-json-btn').click();assert.match((await download).suggestedFilename(),/\.jsonl$/);

  const isolation=await page.evaluate(async(origin)=>{
    let storageDenied=false,fetchDenied=false;
    try {localStorage.getItem('refainery-test')} catch {storageDenied=true}
    try {await fetch(origin+'/probe')} catch {fetchDenied=true}
    const script=document.createElement('script');script.textContent='window.pwned=1';document.body.append(script);
    const image=document.createElement('img');image.setAttribute('onerror','window.pwned=1');
    document.body.append(image);image.dispatchEvent(new Event('error'));
    const frame=document.createElement('iframe');frame.src=origin+'/probe';document.body.append(frame);
    return {storageDenied,fetchDenied,popupDenied:window.open(origin+'/probe')===null};
  },origin);
  assert.deepEqual(isolation,{storageDenied:true,fetchDenied:true,popupDenied:true});
  await page.waitForFunction(()=>['connect-src','script-src-elem','script-src-attr','frame-src'].every(d=>window.violations.includes(d)));
  assert.equal(await page.evaluate(()=>window.pwned),undefined);
  assert.equal(probes,0);assert.deepEqual(errors,[]);
  console.log('Pi viewer browser passed: real offline export rendering, tree filters, JSONL download, opaque origin, and blocked injected scripts/handlers, network, frames and popups.');
} finally {
  await browser?.close();
  if(server) await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});
  await rm(root,{recursive:true,force:true});
}
