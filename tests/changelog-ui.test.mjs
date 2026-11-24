import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness } from './ui-harness.mjs';
import { waitFor } from './helpers.mjs';

async function setup(t, version = '1.0.7') {
  const ui = await uiHarness({ bootstrap: { version, models: [], runs: [], defaultPrompt: 'test' } });
  await waitFor(() => !ui.elements.get('generate').disabled);
  t.after(() => ui.closeStream());
  const entry = ui.elements.get('release-notes');
  assert.ok(entry, 'The plugin needs a visible update-log entry');
  return { ui, entry, body: ui.elements.get('drawer-content') };
}

test('the version entry opens all versions with only the installed version expanded', async t => {
  const { ui, entry, body } = await setup(t);
  assert.equal(entry.hidden, false);
  assert.equal(entry.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(ui.elements.get('header-version').textContent, 'v1.0.7');
  await entry.fire('click');
  assert.equal(ui.elements.get('drawer-title').textContent, '更新日志');
  const versions = ui.descendants(body, 'details');
  assert.deepEqual(versions.map(item => item.dataset.version), ['1.0.7', '1.0.6', '1.0.5', '1.0.4', '1.0.3', '1.0.2', '1.0.1', '1.0.0']);
  assert.deepEqual(versions.filter(item => item.open).map(item => item.dataset.version), ['1.0.7']);
  assert.ok(!ui.descendants(versions[0]).some(item => item.textContent === '本地未发布'));
  assert.ok(ui.descendants(versions[0], 'a').some(item => item.href === 'https://github.com/xiaopeng66/magpie-model-lab/releases/tag/v1.0.7'));
  for (const version of versions) assert.equal(ui.descendants(version, 'a').filter(item => item.textContent === 'GitHub 发行说明' && item.href === `https://github.com/xiaopeng66/magpie-model-lab/releases/tag/v${version.dataset.version}`).length, 1);
});

test('the bootstrap version determines the expanded release instead of array position', async t => {
  const { ui, entry, body } = await setup(t, '1.0.5');
  await entry.fire('click');
  assert.equal(ui.elements.get('header-version').textContent, 'v1.0.5');
  assert.deepEqual(ui.descendants(body, 'details').filter(item => item.open).map(item => item.dataset.version), ['1.0.5']);
});

test('the plugin shows update content while GitHub-only installation and validation sections stay out', async t => {
  const { ui, entry, body } = await setup(t);
  await entry.fire('click');
  for (const release of ui.descendants(body, 'details')) {
    const headings = ui.descendants(release, 'h3').map(item => item.textContent);
    assert.ok(headings.includes('更新内容'), release.dataset.version + ' must keep its update content');
    assert.ok(!headings.some(heading => ['验证', '安装与升级', '使用说明'].includes(heading)), release.dataset.version + ' exposes a GitHub-only section');
    assert.equal(ui.descendants(release, 'pre').length, 0, 'Installation commands belong on GitHub');
    assert.ok(ui.descendants(release, 'li').length > 0, 'Filtering must not leave empty releases');
  }
});

test('closing the log restores entry focus and reopening resets release disclosures', async t => {
  const { ui, entry, body } = await setup(t);
  entry.focus(); await entry.fire('click');
  assert.equal(ui.document.activeElement, ui.elements.get('drawer-title'));
  const versions = ui.descendants(body, 'details');
  versions[0].open = false; versions[1].open = true;
  await ui.elements.get('favorite-drawer').fire('keydown', { key: 'Escape' });
  assert.equal(ui.elements.get('favorite-drawer').hidden, true);
  assert.equal(ui.document.activeElement, entry);
  await entry.fire('click');
  assert.deepEqual(ui.descendants(body, 'details').filter(item => item.open).map(item => item.dataset.version), ['1.0.7']);
  const close = ui.descendants(ui.elements.get('drawer-footer'), 'button').find(item => item.textContent === '关闭');
  assert.ok(close); await close.fire('click');
  assert.equal(ui.document.activeElement, entry);
});

test('collapsed release links stay outside the drawer keyboard cycle', async t => {
  const { ui, entry, body } = await setup(t);
  await entry.fire('click');
  const versions = ui.descendants(body, 'details');
  assert.ok(ui.descendants(versions[0], 'summary')[0].getClientRects().length);
  for (const release of versions.slice(1)) {
    assert.equal(ui.descendants(release, 'a')[0].getClientRects().length, 0);
    assert.ok(ui.descendants(release, 'summary')[0].getClientRects().length);
  }
  const footerClose = ui.descendants(ui.elements.get('drawer-footer'), 'button')[0];
  footerClose.focus();
  await ui.elements.get('favorite-drawer').fire('keydown', { key: 'Tab' });
  assert.equal(ui.document.activeElement, ui.elements.get('drawer-close'));
});

test('opening the bundled log does not fetch GitHub, save settings or start a test', async t => {
  const paths = [];
  const ui = await uiHarness({ request: async path => {
    paths.push(path);
    if (path === 'api/bootstrap') return Response.json({ version: '1.0.6', models: [], runs: [], defaultPrompt: 'test' });
    if (path === 'api/events') return new Response(new ReadableStream());
    throw Error('Unexpected request while reading update log: ' + path);
  } });
  await waitFor(() => !ui.elements.get('generate').disabled);
  const before = [...paths], entry = ui.elements.get('release-notes');
  assert.ok(entry, 'The plugin needs a bundled update-log entry');
  await entry.fire('click');
  await ui.elements.get('drawer-close').fire('click');
  assert.deepEqual(paths, before);
});
