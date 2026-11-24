import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validKey = value => typeof value === 'string' && Boolean(value.trim());
const empty = () => ({ accounts: [], warning: '' });

function defaultConfigDir() {
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const modules = dirname(packageDir), plugins = dirname(modules);
  if (basename(modules) === 'node_modules' && basename(plugins) === 'plugins') return dirname(plugins);
  const configHome = process.env.XDG_CONFIG_HOME;
  return join(configHome && isAbsolute(configHome) ? configHome : join(homedir(), '.config'), 'magpie');
}

function localAddress(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) return null;
    return `${url.protocol}//loopback:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch { return null; }
}

async function readJSON(file, limit, allowEmpty = false) {
  const handle = await open(file, 'r'), chunks = []; let size = 0;
  try {
    if ((await handle.stat()).size > limit) throw Error('Config too large');
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead; if (size > limit) throw Error('Config too large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    return allowEmpty && !text.trim() ? {} : JSON.parse(text);
  } finally { await handle.close(); }
}

function displayName(value, fallback, secrets) {
  let name = typeof value === 'string' ? value : '';
  for (const secret of secrets) name = name.replaceAll(secret, '[已隐藏凭据]');
  return name.replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, '[已隐藏凭据]').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 256) || fallback;
}

const containsCredential = (text, secrets) => secrets.some(key => text.includes(key)) || /\b(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/i.test(text);
function maskedPrefix(key, secrets) {
  const prefix = key.slice(0, Math.max(0, Math.min(8, key.length - 4)));
  return /^[\x21-\x7e]+$/.test(prefix) && !secrets.some(secret => prefix.includes(secret)) ? prefix + '…' : '…';
}
const safeModelID = (value, secrets) => typeof value === 'string' && Boolean(value.trim()) && !/[\x00-\x1f\x7f]/.test(value) && !containsCredential(value, secrets);

async function modelAliases(configDir, secrets) {
  let settings;
  try { settings = await readJSON(join(configDir, 'settings.json'), 8 * 1024 * 1024, true); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  if (!object(settings) || settings.modelIDs != null && !object(settings.modelIDs)) throw Error('Invalid model aliases');
  const aliases = new Map();
  for (const [ref, value] of Object.entries(settings.modelIDs || {})) {
    if (!safeModelID(ref, secrets) || !safeModelID(value, secrets)) throw Error('Invalid model alias');
    const slash = ref.indexOf('/'), provider = ref.slice(0, slash), model = ref.slice(slash + 1), own = value.trim();
    if (slash <= 0 || !model || model === own) continue;
    if (!aliases.has(provider)) aliases.set(provider, new Map());
    const previous = aliases.get(provider).get(own);
    if (!previous || model < previous) aliases.get(provider).set(own, model);
  }
  return aliases;
}

export async function readKeyAccounts({ url, configDir = defaultConfigDir(), onRedact, redactOnly = false }) {
  const address = localAddress(url);
  if (!address || !isAbsolute(configDir)) return empty();
  let descriptor;
  try { descriptor = await readJSON(join(configDir, 'gateway.json'), 65536); }
  catch { return empty(); }
  const servingAddress = typeof descriptor?.addr === 'string' ? descriptor.addr : '';
  if (localAddress(/^https?:\/\//.test(servingAddress) ? servingAddress : 'http://' + servingAddress) !== address) return empty();
  try {
    const config = await readJSON(join(configDir, 'providers.json'), 8 * 1024 * 1024);
    if (!object(config) || !Array.isArray(config.providers)) throw Error('Invalid provider config');
    const secrets = [...new Set(config.providers.flatMap(provider => [provider?.key, ...(Array.isArray(provider?.keys) ? provider.keys.map(key => key?.key) : [])]).filter(validKey))].sort((a, b) => b.length - a.length);
    // The server receives a private redactor, never the credential list or a serializable credential field.
    onRedact?.(value => { for (const secret of secrets) value = value.replaceAll(secret, '[已隐藏凭据]'); return value; });
    if (redactOnly) return empty();
    const aliases = await modelAliases(configDir, secrets), providerIDs = new Map();
    for (const provider of config.providers) if (typeof provider?.id === 'string') providerIDs.set(provider.id, (providerIDs.get(provider.id) || 0) + 1);
    const accounts = [];
    for (const provider of config.providers) {
      if (!object(provider) || typeof provider.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider.id) || provider.account || provider.plugin || containsCredential(provider.id, secrets)) continue;
      const records = [{ key: provider.key, name: provider.keyName, primary: true }, ...(Array.isArray(provider.keys) ? provider.keys : []).map(key => ({ ...key, primary: false }))];
      const distinct = new Map();
      for (const record of records) {
        if (!validKey(record.key)) continue;
        const hash = createHash('sha256').update(record.key).digest('hex');
        const previous = distinct.get(hash);
        if (!previous || !previous.primary && previous.off === true && record.off !== true) distinct.set(hash, record);
      }
      const multiple = validKey(provider.key) && [...distinct.values()].filter(record => record.off !== true).length > 1;
      const shortIDs = new Map();
      for (const hash of distinct.keys()) shortIDs.set(hash.slice(0, 10), (shortIDs.get(hash.slice(0, 10)) || 0) + 1);
      for (const [hash, record] of distinct) {
        const hint = hash.slice(0, 10), enabled = provider.off !== true && validKey(provider.key) && record.off !== true;
        const invalidRules = provider.accountModels != null && !object(provider.accountModels);
        const models = object(provider.accountModels) ? provider.accountModels[hint] : undefined;
        let reason = providerIDs.get(provider.id) > 1 ? '供应商标识冲突，请在 Magpie 检查供应商配置' : shortIDs.get(hint) > 1 ? '宿主 Key 短标识冲突，请在 Magpie 更换冲突 Key' : provider.off === true ? '供应商已停用' : !validKey(provider.key) ? '供应商缺少有效主 Key' : record.off === true ? 'Key 已停用' : '';
        if (invalidRules || models != null && (!Array.isArray(models) || models.some(model => !safeModelID(model, secrets)))) reason ||= '此 Key 的模型限制配置无效，请在 Magpie 修复';
        const allowed = Array.isArray(models) && models.length && !reason ? new Set(models.map(model => model.trim())) : null;
        if (allowed) {
          const originalModels = new Set(allowed);
          for (const [own, model] of aliases.get(provider.id) || []) if (originalModels.has(own)) allowed.add(model);
        }
        accounts.push({ provider: provider.id, id: 'key:' + hash, name: displayName(record.name, record.primary ? '主 Key' : '附加 Key', secrets),
          kind: 'key', primary: record.primary, keyHint: hint, keyPrefix: maskedPrefix(record.key, secrets), enabled, available: reason ? false : null, ...(reason ? { unavailableReason: reason } : {}),
          routingId: multiple ? provider.id + '#' + hint : provider.id,
          modelIds: allowed ? [...allowed].map(model => provider.id + '/' + model) : null });
      }
    }
    return { accounts, warning: '' };
  } catch { return { accounts: [], warning: '本机 API Key 配置暂不可读，请在 Magpie 检查供应商配置后刷新。' }; }
}
