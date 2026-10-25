// Optional read-only check of a completed real run. No model calls or writes.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Store } from '../source/backend/storage.ts';
import { createAppServer } from '../source/server.ts';

if (!process.env.REFAINERY_STORAGE_DIR) throw Error('Explicit saved production storage required');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const server=createAppServer(undefined,new Store(process.env.REFAINERY_STORAGE_DIR));
let browser;
try {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/v1');await page.waitForSelector('.floor-bar');
  assert.ok(await page.locator('#test-notice').isHidden());
  assert.match(await page.locator('#snapshot-time').textContent(),/PRODUCTION/);
  assert.match(await page.locator('#outcome-chart').textContent(),/decisions recorded/);
  assert.match(await page.locator('#configuration-models').textContent(),/web_search/);
  await page.locator('.floor-job-button').last().click();
  const inspector=page.locator('.floor-inspector');
  assert.match(await inspector.textContent(),/Plan history/);
  assert.match(await inspector.textContent(),/Requested: ~openai\/gpt-luna-latest/);
  assert.match(await inspector.textContent(),/Actual \(provider-reported\): openai\/gpt-6-luna/);
  await inspector.getByText(/Plan history/).click();
  assert.match(await inspector.textContent(),/000001.md/);assert.match(await inspector.textContent(),/000002.md/);
  // Historical seconds-long bars can overlap at minimum pixel width as the
  // current-time axis grows. Use the real job list, not a forced/hidden click.
  await inspector.getByRole('button',{name:/^subagent:/}).last().click();
  assert.match(await inspector.textContent(),/Decision recorded/);
  assert.match(await inspector.textContent(),/Markdown handover/);
  const link=await inspector.locator('a.transcript-link').getAttribute('href');
  const documents=(await (await fetch(origin+'/api/v1/preview')).json()).documents.filter(d=>d.kind==='html');
  assert.ok(documents.some(d=>d.url===link));
  assert.ok(documents.some(d=>d.path==='exports/orchestrator.html'));
  for(const doc of documents) {
    const exported=await browser.newPage();exported.on('pageerror',e=>errors.push(e.message));
    const response=await exported.goto(origin+doc.url);
    assert.match(response.headers()['content-security-policy'],/^sandbox allow-scripts allow-downloads;/);
    await exported.waitForSelector('#header-container h1');
    assert.match(await exported.locator('#header-container h1').textContent(),/^Session:/);
    assert.ok(await exported.locator('#messages .assistant-message').count()>0);
    assert.ok(await exported.locator('.tree-node').count()>0);
    assert.match(await exported.locator('#messages').textContent(),/milestone/);
    assert.equal(await exported.getByRole('heading',{name:'Saved Pi session',exact:true}).count(),0);
    await exported.getByRole('button',{name:'Toggle tools',exact:true}).click();
    assert.equal(await exported.getByRole('button',{name:'Toggle tools',exact:true}).getAttribute('aria-pressed'),'true');
    const tool=exported.locator('.tool-item[onclick]').first();
    await tool.click();assert.match(await tool.getAttribute('class'),/params-expanded/);
    const download=exported.waitForEvent('download');
    await exported.getByRole('button',{name:'↓ JSONL',exact:true}).click();await download;
    await exported.close();
  }
  await page.locator('#refresh-preview').click();await page.waitForFunction(()=>!document.querySelector('#refresh-preview').disabled);
  assert.equal(await page.locator('.floor-bar[aria-pressed="true"]').count(),1);
  for(const width of [1280,375]) {
    await page.setViewportSize({width,height:1000});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  assert.deepEqual(errors,[]);
  if(process.env.REFAINERY_SCREENSHOT) await page.screenshot({path:process.env.REFAINERY_SCREENSHOT,fullPage:true});
  console.log('Production browser passed: real timeline, plan history, model identities, handover, decision, native Pi viewers, controls and JSONL downloads, refresh and mobile layout.');
} finally {
  await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections()});
}
