import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Exercise Pi's actual file exporter, offline, with no model/runtime credentials.
export async function nativeExport(root, text = 'Offline **Pi export** verification.') {
  const { exportFromFile } = await import(new URL('./core/export-html/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
  const timestamp = '2026-10-25T00:00:00.000Z';
  const sessionFile = join(root, 'offline.jsonl');
  const entries = [
    { type:'session', version:3, id:'offline-export', timestamp, cwd:root },
    { type:'message', id:'user0001', parentId:null, timestamp,
      message:{role:'user',content:'Show the native Pi viewer.',timestamp:Date.parse(timestamp)} },
    { type:'message', id:'asst0001', parentId:'user0001', timestamp,
      message:{role:'assistant',content:[{type:'text',text}],timestamp:Date.parse(timestamp),
        api:'openai-completions',provider:'offline',model:'offline-model',stopReason:'stop',
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}} },
  ];
  await writeFile(sessionFile,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const output = join(root,'native.html');
  await exportFromFile(sessionFile,{outputPath:output});
  return {html:await readFile(output,'utf8'),sessionFile,exportToHtml:path=>exportFromFile(sessionFile,{outputPath:path})};
}

export function withLegacyFallback(native) {
  return native.replace('<body>','<body><section style="padding:2rem"><h1>Saved Pi session</h1><p>refAInery static active-branch transcript. The original Pi viewer is retained below, but scripts are disabled on this server.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">[]</pre></section>');
}
