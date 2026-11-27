import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary, fakeGateway, startTestServer } from './helpers.mjs';

test('native configuration save exports a shareable config through the authenticated local endpoint', async t => {
  const dir = await temporary(t), upstream = await fakeGateway(t), path = join(dir, 'config.json'); let suggestedFilename;
  const service = await startTestServer({ port: 0, dataDir: dir, gatewayUrl: upstream.url, saveExport: async (value, filename) => { suggestedFilename = filename; await writeFile(path, JSON.stringify(value)); return { path }; } }); t.after(() => service.close());
  const html = await (await fetch(service.url)).text(), headers = { 'x-pelican-token': html.match(/name="pelican-token" content="([^"]+)"/)[1], 'content-type': 'application/json' };
  const response = await fetch(service.url + 'api/config/save', { method: 'POST', headers, body: JSON.stringify({ shareMode: true }) }); assert.equal(response.status, 200); assert.equal((await response.json()).path, path);
  const saved = JSON.parse(await readFile(path, 'utf8')); assert.equal(saved.schema, 'model-lab-config-v1'); assert.equal(saved.pluginVersion, '1.0.9'); assert.equal(upstream.seen.requests.length, 0);
  assert.equal(suggestedFilename, 'magpie-model-lab-config-1.0.9.json');
});
