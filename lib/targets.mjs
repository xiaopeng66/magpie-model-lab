// Data-only target rules also run in the browser; no host state or credentials.
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
export function identityHash(text) {
  const input = new TextEncoder().encode(text), size = Math.ceil((input.length + 9) / 64) * 64, data = new Uint8Array(size), view = new DataView(data.buffer);
  data.set(input); data[input.length] = 128; view.setUint32(size - 8, Math.floor(input.length * 8 / 4294967296)); view.setUint32(size - 4, input.length * 8);
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Int32Array(64), rotate = (x, n) => x >>> n | x << (32 - n);
  for (let offset = 0; offset < size; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 64; i++) { const a = w[i-15], b = w[i-2]; w[i] = w[i-16] + (rotate(a,7)^rotate(a,18)^a>>>3) + w[i-7] + (rotate(b,17)^rotate(b,19)^b>>>10); }
    let [a,b,c,d,e,f,g,k] = h;
    for (let i = 0; i < 64; i++) { const t = (k + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + constants[i] + w[i]) | 0, s = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) | 0; k=g;g=f;f=e;e=(d+t)|0;d=c;c=b;b=a;a=(t+s)|0; }
    [a,b,c,d,e,f,g,k].forEach((value, i) => { h[i] = (h[i] + value) | 0; });
  }
  return h.map(value => (value >>> 0).toString(16).padStart(8,'0')).join('');
}
export function validAccountId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id) && !/[\ud800-\udfff]/u.test(id.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')); }
export function accountHeader(id) { if (!validAccountId(id)) fail('固定账号标识无效'); return /^[\x20-\x7e]+$/.test(id) ? id : encodeURIComponent(id); }
export function normalizeAccount(value = { mode: 'auto' }) {
  if (!object(value) || Object.keys(value).some(key => !['mode','id','name'].includes(key))) fail('账号目标结构无效');
  if (value.mode === 'auto' && value.id == null && value.name == null) return { mode: 'auto' };
  if (value.mode !== 'pinned' || !validAccountId(value.id) || value.name != null && (typeof value.name !== 'string' || value.name.length > 256 || /[\x00-\x1f\x7f]/.test(value.name))) fail('固定账号目标无效');
  return { mode: 'pinned', id: value.id, ...(value.name ? { name: value.name } : {}) };
}
export function normalizeTarget(value) {
  if (!object(value) || typeof value.modelId !== 'string' || !value.modelId || /[\x00-\x1f\x7f]/.test(value.modelId)) fail('模型目标无效');
  const provider = value.modelId.split('/')[0]; if (value.provider != null && value.provider !== provider) fail('账号供应商与模型不一致');
  const account = normalizeAccount(value.account), targetKey = identityHash(JSON.stringify([provider,value.modelId,account.mode,account.id || '']));
  if (value.targetKey != null && value.targetKey !== targetKey) fail('账号目标身份不一致');
  return { provider, modelId: value.modelId, account, targetKey };
}
export function readRunTarget(run) {
  return normalizeTarget({ modelId: run.model, account: run.accountTarget ?? (run.kind === 'fingerprint' && run.account ? { mode: 'pinned', id: run.account } : { mode: 'auto' }), ...(run.targetKey ? { targetKey: run.targetKey } : {}) });
}
export function readFavoriteTarget(favorite, kind) {
  const account = favorite.account?.mode === 'pinned' ? favorite.account : kind === 'fingerprint' && favorite.fingerprint?.account ? { mode: 'pinned', id: favorite.fingerprint.account } : { mode: 'auto' };
  return normalizeTarget({ modelId: favorite.modelId, account });
}
export function routingEvidence(account, evidence = {}, source = null) {
  const reported = [evidence.accountId, evidence.providerAccount].find(validAccountId) || null;
  return { requestedAccountId: account?.mode === 'pinned' ? account.id : null, reportedAccountId: reported,
    verification: account?.mode === 'pinned' && reported ? reported === account.id ? 'verified' : 'mismatch' : 'unavailable',
    provider: typeof evidence.provider === 'string' ? evidence.provider : null, model: typeof evidence.model === 'string' ? evidence.model : null, source };
}
export function targetLabel(run) { const account = run.accountTarget || run.account; return account?.mode === 'pinned' ? account.name || account.id : run.kind === 'fingerprint' && typeof account === 'string' && account ? account : ''; }
