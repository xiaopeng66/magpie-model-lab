import { randomUUID } from "node:crypto";
import { StateFile } from "./state-file.mjs";
import { normalizeParameters, parameterDefaults } from "./test-parameters.mjs";
import { invalid, DEFAULT_PROMPT } from "./gateway.mjs";
import { UUID } from "./store.mjs";
import { validateQueue } from './queue-policy.mjs';

const kinds = ["pelican", "candy", "fingerprint"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid("配置包含未知字段或无效结构");
}
function retention(value) { keys(value, ["days"]); if (!(value.days === null || Number.isInteger(value.days) && value.days >= 1 && value.days <= 36500)) throw invalid("保留天数需为 1–36500 的整数，或永久保留"); }
function notice(value) { keys(value, ["enabled"]); if (typeof value.enabled !== "boolean") throw invalid("静默提醒开关无效"); }
export class Settings {
  constructor(dataDir, { defaultPrompt = DEFAULT_PROMPT, capabilities = {} } = {}) {
    this.defaultPrompt = defaultPrompt;
    this.capabilities = { memory: true, presets: false, retention: false, progressNotice: false, ...capabilities };
    const initial = { schema: 1, revision: 0, manual: Object.fromEntries(kinds.map(kind => [kind, parameterDefaults(kind, defaultPrompt)])), retention: { days: 7 }, progressNotice: { enabled: true }, presets: [] };
    this.file = new StateFile(dataDir, ".settings", initial, value => this.validate(value));
  }
  get recoveryError() { return this.file.recoveryError; }
  async init() {
    await this.file.init();
    if (this.recoveryError || !Object.hasOwn(this.file.data, 'budget')) return;
    // RYP: remove legacy quota settings while preserving the separate usage ledger.
    await this.file.enqueue(async () => { const next = this.snapshot(); delete next.budget; next.revision++; await this.file.commit(next); });
  }
  snapshot() { return this.file.snapshot(); }
  bootstrap() {
    const { revision, manual, retention, progressNotice, presets, queue } = this.snapshot();
    return { revision, manual, retention, progressNotice, ...(queue ? {queue} : {}), presetCatalog: presets.map(({ id, name, kind, createdAt, updatedAt }) => ({ id, name, kind, createdAt, updatedAt })) };
  }
  validate(value) {
    keys(value, ["schema", "revision", "manual", "retention", "progressNotice", "presets", 'queue', 'budget']);
    if (![1,2].includes(value.schema) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw invalid("不支持的设置格式或 revision");
    if (value.queue !== undefined) validateQueue(value.queue);
    if (value.budget !== undefined && !object(value.budget)) throw invalid('旧设置格式无效');
    keys(value.manual, kinds);
    for (const kind of kinds) {
      const parameters = value.manual[kind]; normalizeParameters(kind, parameters, { defaultPrompt: this.defaultPrompt });
      if (Object.keys(parameterDefaults(kind, this.defaultPrompt)).some(key => !Object.hasOwn(parameters, key))) throw invalid("保存的参数组不完整");
    }
    retention(value.retention); notice(value.progressNotice);
    if (!Array.isArray(value.presets) || value.presets.length > 50) throw invalid("预设最多保存 50 个");
    const ids = new Set(), names = new Set();
    for (const preset of value.presets) {
      keys(preset, ["id", "name", "kind", "parameters", "createdAt", "updatedAt"]);
      if (!UUID.test(preset.id || "") || ids.has(preset.id) || typeof preset.name !== "string" || !preset.name.trim() || /[\x00-\x1f\x7f]/.test(preset.name) || preset.name !== preset.name.trim() || [...preset.name].length > 40 || names.has(`${preset.kind}\0${preset.name}`)) throw invalid("预设名称、ID 或重复名称无效");
      if (![preset.createdAt, preset.updatedAt].every(at => typeof at === "string" && Number.isFinite(Date.parse(at)))) throw invalid("预设时间无效");
      normalizeParameters(preset.kind, preset.parameters, { defaultPrompt: this.defaultPrompt });
      if (Object.keys(parameterDefaults(preset.kind, this.defaultPrompt)).some(key => !Object.hasOwn(preset.parameters, key))) throw invalid("保存的预设参数不完整");
      ids.add(preset.id); names.add(`${preset.kind}\0${preset.name}`);
    }
  }
  save(request, { authorizeRetentionChange } = {}) {
    const accepted = structuredClone(request);
    return this.file.enqueue(async () => {
      keys(accepted, ["expectedRevision", "patch"]);
      const before = this.snapshot(), { expectedRevision, patch } = accepted;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw invalid("设置 revision 无效");
      if (before.revision !== expectedRevision) throw invalid("设置已被其他页面更新，请核对后再保存", 409);
      keys(patch, ["manual", "retention", "progressNotice", "presetUpsert", "presetDelete", 'queue']);
      if (!Object.keys(patch).length || patch.presetUpsert && patch.presetDelete) throw invalid("请选择一项有效的设置修改");
      const next = structuredClone(before), changed = {}; let preset;
      if (patch.queue !== undefined) { if (!this.capabilities.queue) throw invalid('当前服务未开放队列规则',409); next.queue=validateQueue(patch.queue);changed.queue=next.queue;next.schema=2; }
      if (patch.manual !== undefined) {
        keys(patch.manual, kinds); const selected = Object.keys(patch.manual);
        if (selected.length !== 1) throw invalid("一次保存只能替换一个模式的完整参数组");
        const kind = selected[0]; next.manual[kind] = normalizeParameters(kind, patch.manual[kind], { defaultPrompt: this.defaultPrompt }); changed.manual = { [kind]: next.manual[kind] };
      }
      if (patch.retention !== undefined) {
        retention(patch.retention); next.retention = { ...patch.retention }; changed.retention = next.retention;
        if (before.retention.days !== next.retention.days) {
          if (!this.capabilities.retention || !authorizeRetentionChange) throw invalid("当前服务未开放保留策略修改", 409);
          await authorizeRetentionChange({ before, after: next });
        }
      }
      if (patch.progressNotice !== undefined) { notice(patch.progressNotice); if (!this.capabilities.progressNotice) throw invalid("当前服务未开放运行提醒设置", 409); next.progressNotice = { ...patch.progressNotice }; changed.progressNotice = next.progressNotice; }
      if (patch.presetUpsert !== undefined || patch.presetDelete !== undefined) {
        if (!this.capabilities.presets) throw invalid("当前服务未开放参数预设", 409);
        if (patch.presetDelete) {
          keys(patch.presetDelete, ["id"]);
          if (!next.presets.some(p => p.id === patch.presetDelete.id)) throw invalid("预设已不存在", 404);
          next.presets = next.presets.filter(p => p.id !== patch.presetDelete.id);
        } else {
          const input = patch.presetUpsert; keys(input, ["id", "name", "kind", "parameters"]);
          const old = input.id ? next.presets.find(p => p.id === input.id) : null;
          if (input.id && !old) throw invalid("预设已不存在", 404);
          if (old && input.kind !== old.kind) throw invalid("不能更改预设所属模式");
          const at = new Date().toISOString();
          preset = { id: old?.id || randomUUID(), name: typeof input.name === "string" ? input.name.trim() : input.name, kind: input.kind,
            parameters: normalizeParameters(input.kind, input.parameters, { defaultPrompt: this.defaultPrompt }), createdAt: old?.createdAt || at, updatedAt: at };
          next.presets = [...next.presets.filter(p => p.id !== preset.id), preset];
        }
        changed.presetCatalog = next.presets.map(({ id, name, kind, createdAt, updatedAt }) => ({ id, name, kind, createdAt, updatedAt }));
      }
      next.revision++; await this.file.commit(next);
      return { revision: next.revision, changed: structuredClone(changed), ...(preset ? { preset: structuredClone(preset) } : {}), recoveryError: "" };
    });
  }
  close() { return this.file.close(); }
}
