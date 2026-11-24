import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary } from './helpers.mjs';

async function content() {
  const dataFile = new URL('../ui/release-notes.mjs', import.meta.url);
  const formatterFile = new URL('../tools/release-notes.mjs', import.meta.url);
  assert.ok(existsSync(dataFile), 'The bundled version log must have a shared content source');
  assert.ok(existsSync(formatterFile), 'GitHub release notes need a common Markdown exporter');
  const { releaseNotes } = await import(dataFile);
  const { formatReleaseNotes } = await import(formatterFile);
  return { releaseNotes, formatReleaseNotes };
}

test('all published releases use one heading order and their own pinned installation command', async () => {
  const { releaseNotes, formatReleaseNotes } = await content();
  const published = releaseNotes.filter(item => !item.local);
  assert.deepEqual(published.map(item => item.version), ['1.0.7', '1.0.6', '1.0.5', '1.0.4', '1.0.3', '1.0.2', '1.0.1', '1.0.0']);
  for (const release of published) {
    const body = formatReleaseNotes(release);
    const headings = [...body.matchAll(/^## (.+)$/gm)].map(match => match[1]);
    assert.deepEqual(headings, ['更新内容', ...(['1.0.7', '1.0.6'].includes(release.version) ? ['体验优化'] : []), ...(release.version !== '1.0.2' ? ['验证'] : []), '安装与升级', ...(release.sections.some(item => item.heading === '使用说明') ? ['使用说明'] : [])]);
    assert.ok(body.includes(`github:xiaopeng66/magpie-model-lab#v${release.version}`));
    assert.ok(body.startsWith(release.summary + '\n\n'));
    assert.ok(body.endsWith('\n'));
    assert.ok(!body.includes('\r'));
    if (release.version !== '1.0.6') assert.ok(!body.includes('1.0.6'), 'New features must never enter earlier release notes');
  }
});

test('display dates follow actual GitHub publication times in Beijing time', async () => {
  const { releaseNotes } = await content();
  for (const release of releaseNotes.filter(item => !item.local)) {
    if (release.publishedAt) {
      assert.equal(release.date, new Date(Date.parse(release.publishedAt) + 8 * 3600000).toISOString().slice(0, 10));
    } else {
      assert.equal(release.version, '1.0.7', 'Historical releases must keep their actual GitHub timestamp');
      assert.equal(release.date, '2026-11-24', 'The prepared release date must be verified against GitHub after publishing');
    }
    assert.equal(release.url, `https://github.com/xiaopeng66/magpie-model-lab/releases/tag/v${release.version}`);
  }
  const latestPublished = releaseNotes.find(release => !release.local);
  assert.equal(latestPublished.url, 'https://github.com/xiaopeng66/magpie-model-lab/releases/tag/v1.0.7');
});

test('historical validation evidence and the 1.0.4 limits remain historical facts', async () => {
  const { releaseNotes, formatReleaseNotes } = await content();
  const bodies = new Map(releaseNotes.map(item => [item.version, formatReleaseNotes(item)]));
  for (const [version, total] of [['1.0.5', 399], ['1.0.4', 387], ['1.0.3', 285], ['1.0.1', 254], ['1.0.0', 239]]) {
    assert.match(bodies.get(version), new RegExp(String(total) + ' 项'));
  }
  assert.match(bodies.get('1.0.4'), /7 天/);
  assert.match(bodies.get('1.0.4'), /600 秒/);
  assert.match(bodies.get('1.0.4'), /4 MiB/);
  assert.match(bodies.get('1.0.4'), /16 MiB/);
  assert.match(bodies.get('1.0.4'), /后续功能需求/);
  assert.ok(!bodies.get('1.0.2').includes('项测试通过'), 'No test result was stated in the original 1.0.2 release');
  assert.match(bodies.get('1.0.0'), /0\.1\.2905/);
  assert.match(bodies.get('1.0.0'), /docs\/favorites-guide\.md/);
});

test('the exporter writes the chosen release to a new output folder', async t => {
  const { releaseNotes, formatReleaseNotes } = await content();
  const folder = await temporary(t), output = join(folder, 'release-notes', 'v1.0.6.md');
  const command = fileURLToPath(new URL('../tools/release-notes.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, '1.0.6', output], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(output, 'utf8'), formatReleaseNotes(releaseNotes.find(item => item.version === '1.0.6')));
});

test('the exporter rejects a local unpublished version without writing a file', async t => {
  await content();
  const folder = await temporary(t), output = join(folder, 'v1.0.7.md');
  const command = join(folder, 'tools', 'release-notes.mjs');
  await mkdir(join(folder, 'tools')); await mkdir(join(folder, 'ui'));
  await writeFile(command, await readFile(new URL('../tools/release-notes.mjs', import.meta.url), 'utf8'));
  await writeFile(join(folder, 'ui', 'release-notes.mjs'), "export const releaseNotes = [{ version: '1.0.7', local: true, summary: 'Unpublished test release', sections: [] }];\n");
  const result = spawnSync(process.execPath, [command, '1.0.7', output], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /已发布版本/);
  assert.equal(existsSync(output), false);
});
