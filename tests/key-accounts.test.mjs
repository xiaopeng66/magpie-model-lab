import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';

const module = await import('../lib/key-accounts.mjs').catch(() => ({}));
const primaryKey = 'synthetic-primary-key', spareKey = 'synthetic-spare-key';
const fullID = key => 'key:' + createHash('sha256').update(key).digest('hex');
const shortID = key => createHash('sha256').update(key).digest('hex').slice(0, 10);
const url = 'http://127.0.0.1:33421';

async function fixture(t, providers) {
  const configDir = await temporary(t);
  await writeFile(join(configDir, 'gateway.json'), JSON.stringify({ addr: '127.0.0.1:33421', version: '0.1.4572', pid: 123 }));
  const save = list => writeFile(join(configDir, 'providers.json'), JSON.stringify({ providers: list }));
  await save(providers);
  return { configDir, save, read: async () => {
    assert.equal(typeof module.readKeyAccounts, 'function', 'Ordinary Key discovery is missing');
    return module.readKeyAccounts({ url, configDir });
  } };
}

test('ordinary primary and additional Keys expose safe stable identities and configured model limits', async t => {
  const env = await fixture(t, [{ id: 'fixture', key: primaryKey, keyName: '主账号', keys: [{ key: spareKey, name: '分组 B' }], accountModels: { [shortID(spareKey)]: ['one', 'vendor/nested'] } }]);
  const result = await env.read();
  assert.equal(result.warning, '');
  assert.equal(result.accounts.length, 2);
  const [primary, spare] = result.accounts;
  assert.deepEqual([primary.id, spare.id], [fullID(primaryKey), fullID(spareKey)]);
  assert.deepEqual([primary.routingId, spare.routingId], ['fixture#942e114ed5', 'fixture#e8774afc67']);
  assert.equal(primary.kind, 'key'); assert.equal(primary.primary, true); assert.equal(spare.primary, false);
  assert.equal(primary.name, '主账号'); assert.equal(spare.name, '分组 B');
  assert.equal(primary.modelIds, null);
  assert.deepEqual(spare.modelIds, ['fixture/one', 'fixture/vendor/nested']);
  assert.equal(primary.available, null, 'A configured Key has not yet proved authentication');
  assert.equal(JSON.stringify(result).includes(primaryKey), false);
  assert.equal(JSON.stringify(result).includes(spareKey), false);
});

test('short Key previews hide at least four characters and cannot reveal another complete credential', async t => {
  const env = await fixture(t, [{ id: 'fixture', key: 'abcd', keys: [{ key: '1234567' }, { key: 'abcd-another-secret' }] }]);
  const { accounts } = await env.read();
  assert.deepEqual(accounts.map(account => account.keyPrefix), ['…', '123…', '…']);
});

test('renaming, reordering and becoming the only enabled Key preserve the saved account identity', async t => {
  const provider = { id: 'fixture', key: primaryKey, keys: [{ key: spareKey, name: '原名称' }] };
  const env = await fixture(t, [provider]), before = (await env.read()).accounts;
  await env.save([{ ...provider, key: spareKey, keyName: '新名称', keys: [{ key: primaryKey, name: '重名', off: true }] }]);
  const after = (await env.read()).accounts;
  assert.equal(after[0].id, before[1].id);
  assert.equal(after[1].id, before[0].id);
  assert.equal(after[0].routingId, 'fixture');
  assert.equal(after[0].name, '新名称');
  assert.equal(after[1].enabled, false);
  assert.equal(after[1].available, false);
});

test('duplicate credentials are one account and the first enabled occurrence follows the host routing order', async t => {
  const env = await fixture(t, [{ id: 'fixture', key: primaryKey, keys: [{ key: primaryKey, name: '重复主 Key' }, { key: spareKey, name: '关闭的重复项', off: true }, { key: spareKey, name: '启用项' }] }]);
  const { accounts } = await env.read();
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].primary, true);
  assert.equal(accounts[1].name, '启用项');
  assert.equal(accounts[1].enabled, true);
  assert.equal(accounts[1].routingId, 'fixture#e8774afc67');
});

test('disabled suppliers and additional Keys without a primary cannot become usable targets', async t => {
  const env = await fixture(t, [
    { id: 'off', off: true, key: primaryKey },
    { id: 'missing-primary', keys: [{ key: spareKey }] },
    { id: 'subscription', account: { user: 'registered' }, key: primaryKey },
    { id: 'plugin', plugin: 'fixture-plugin', key: primaryKey },
  ]);
  const { accounts } = await env.read();
  assert.deepEqual(accounts.map(account => account.provider), ['off', 'missing-primary']);
  assert.ok(accounts.every(account => account.enabled === false && account.available === false && account.unavailableReason));
});

test('foreign and mismatched local gateways do not read the local provider credential file', async t => {
  const env = await fixture(t, []);
  await writeFile(join(env.configDir, 'providers.json'), 'invalid JSON containing ' + primaryKey);
  for (const gatewayURL of ['https://remote.example', 'http://127.0.0.1:33422', 'http://127.0.0.1:33421/other', 'http://example-user@127.0.0.1:33421']) {
    assert.equal(typeof module.readKeyAccounts, 'function', 'Ordinary Key discovery is missing');
    const result = await module.readKeyAccounts({ url: gatewayURL, configDir: env.configDir });
    assert.deepEqual(result.accounts, []);
    assert.equal(result.warning, '', 'Unrelated local configuration must remain unread');
  }
  const own = await env.read(); assert.ok(own.warning); assert.equal(own.warning.includes(primaryKey), false);
});

test('credential-looking aliases and malformed model restrictions cannot expose secrets or permit arbitrary models', async t => {
  const env = await fixture(t, [{ id: 'fixture', key: primaryKey, keyName: '错误备注 ' + spareKey, keys: [{ key: spareKey, name: primaryKey }], accountModels: { [shortID(spareKey)]: 'not-an-array' } }]);
  const result = await env.read();
  assert.equal(result.accounts.length, 2);
  assert.equal(JSON.stringify(result).includes(primaryKey), false);
  assert.equal(JSON.stringify(result).includes(spareKey), false);
  assert.equal(result.accounts[1].available, false);
  assert.ok(result.accounts[1].unavailableReason);
});

test('Key model restrictions accept Magpie public aliases and the first lexical alias for the same vendor model', async t => {
  const env = await fixture(t, [{ id: 'fixture', key: primaryKey, keys: [{ key: spareKey }], accountModels: { [shortID(spareKey)]: ['vendor/nested', 'direct'] } }]);
  await writeFile(join(env.configDir, 'settings.json'), JSON.stringify({ modelIDs: {
    'other/unrelated': 'vendor/nested', 'fixture/z-last': 'vendor/nested', 'fixture/a-first': ' vendor/nested ', 'fixture/direct': 'direct',
  } }));
  const result = await env.read();
  assert.equal(result.warning, '');
  assert.deepEqual(result.accounts[1].modelIds, ['fixture/vendor/nested', 'fixture/direct', 'fixture/a-first']);
  assert.equal(result.accounts[1].modelIds.includes('fixture/z-last'), false);
  await writeFile(join(env.configDir, 'settings.json'), '');
  assert.deepEqual((await env.read()).accounts[1].modelIds, ['fixture/vendor/nested', 'fixture/direct']);
});

test('credentials accidentally stored in model limits or alias mappings stay out of metadata', async t => {
  const env = await fixture(t, [{ id: 'fixture', key: primaryKey, keys: [{ key: spareKey }], accountModels: { [shortID(spareKey)]: [primaryKey] } }]);
  let result = await env.read();
  assert.equal(result.accounts[1].available, false);
  assert.equal(result.accounts[1].modelIds, null);
  assert.equal(JSON.stringify(result).includes(primaryKey), false);
  await env.save([{ id: 'fixture', key: primaryKey, accountModels: { [shortID(primaryKey)]: ['vendor/model'] } }]);
  await writeFile(join(env.configDir, 'settings.json'), JSON.stringify({ modelIDs: { ['fixture/' + primaryKey]: 'vendor/model' } }));
  result = await env.read();
  assert.deepEqual(result.accounts, []); assert.ok(result.warning);
  assert.equal(JSON.stringify(result).includes(primaryKey), false);
});

test('duplicate supplier IDs cannot silently pin credentials from another supplier record', async t => {
  const env = await fixture(t, [{ id: 'fixture', key: primaryKey }, { id: 'fixture', key: spareKey }]);
  const { accounts } = await env.read();
  assert.equal(accounts.length, 2);
  assert.ok(accounts.every(account => account.available === false && /供应商.*冲突/.test(account.unavailableReason)));
});

test('malformed model alias settings do not permit restricted Keys with guessed identities', async t => {
  const env = await fixture(t, [{ id: 'fixture', key: primaryKey, accountModels: { [shortID(primaryKey)]: ['vendor/model'] } }]);
  for (const contents of ['invalid JSON ' + primaryKey, JSON.stringify({ modelIDs: ['not-a-map'] }), JSON.stringify({ modelIDs: { 'fixture/public': 42 } })]) {
    await writeFile(join(env.configDir, 'settings.json'), contents);
    const result = await env.read();
    assert.deepEqual(result.accounts, []); assert.ok(result.warning);
    assert.equal(JSON.stringify(result).includes(primaryKey), false);
  }
});

test('model aliases use one host mapping step and supplier names do not collide with object properties', async t => {
  const env = await fixture(t, [{ id: 'constructor', key: primaryKey, accountModels: { [shortID(primaryKey)]: ['vendor/model'] } }]);
  await writeFile(join(env.configDir, 'settings.json'), JSON.stringify({ modelIDs: { 'constructor/public': 'vendor/model', 'constructor/other': 'public' } }));
  const result = await env.read();
  assert.equal(result.warning, '');
  assert.deepEqual(result.accounts[0].modelIds, ['constructor/vendor/model', 'constructor/public']);
});

test('different Keys colliding in the host short fingerprint are unavailable instead of sharing a request seat', async t => {
  const one = 'synthetic-collision-b-534384', two = 'synthetic-collision-b-654109';
  assert.equal(shortID(one), '576453307f'); assert.equal(shortID(two), '576453307f');
  const env = await fixture(t, [{ id: 'fixture', key: one, keys: [{ key: two }] }]);
  const { accounts } = await env.read();
  assert.equal(accounts.length, 2); assert.notEqual(accounts[0].id, accounts[1].id);
  assert.ok(accounts.every(account => account.available === false && /冲突/.test(account.unavailableReason)));
});

test('oversized and invalid provider files fail closed with a fixed safe warning', async t => {
  const env = await fixture(t, []);
  for (const content of [JSON.stringify({ providers: {} }), '{"providers":[' + primaryKey, ' '.repeat(8 * 1024 * 1024 + 1)]) {
    await writeFile(join(env.configDir, 'providers.json'), content);
    const result = await env.read();
    assert.deepEqual(result.accounts, []); assert.ok(result.warning); assert.equal(result.warning.includes(primaryKey), false);
  }
});

test('credential metadata files reject symbolic links instead of following files outside the config directory', async t => {
  const env = await fixture(t, [{ id: 'fixture', key: primaryKey }]);
  const outside = join(await temporary(t), 'outside.json');
  await writeFile(outside, JSON.stringify({ providers: [{ id: 'outside', key: spareKey }] }));
  await rm(join(env.configDir, 'providers.json'));
  await symlink(outside, join(env.configDir, 'providers.json'), 'file');
  let result = await env.read();
  assert.deepEqual(result.accounts, []);
  assert.ok(result.warning);
  assert.equal(JSON.stringify(result).includes(spareKey), false);

  await rm(join(env.configDir, 'providers.json'));
  await env.save([{ id: 'fixture', key: primaryKey, accountModels: { [shortID(primaryKey)]: ['fixture/model'] } }]);
  const aliases = join(await temporary(t), 'aliases.json');
  await writeFile(aliases, JSON.stringify({ modelIDs: { 'fixture/public': 'fixture/model' } }));
  await symlink(aliases, join(env.configDir, 'settings.json'), 'file');
  result = await env.read();
  assert.deepEqual(result.accounts, []);
  assert.ok(result.warning);
});
