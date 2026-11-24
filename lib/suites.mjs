import { CANDY_PROMPT, classifyCandy } from './candy.mjs';
import { identityHash } from './targets.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const suites = [
  { id: 'shape-choice', version: '1', name: '原糖果题', questions: [
    { id: 'shape-choice', name: '可选形状的糖果', prompt: CANDY_PROMPT, expected: 21, graderId: 'exact-number', graderVersion: '1' },
  ] },
];
const findSuite = (id, version) => suites.find(suite => suite.id === id && suite.version === version);
export const suiteCatalog = () => suites.map(({ id, version, name, questions }) => ({ id, version, name, questions: questions.map(({ id, name }) => ({ id, name })) }));
export function taskFor(suiteId, suiteVersion, questionId) {
  if (suiteId === 'reasoning-basics') throw invalid('基础推理三题已移除，仅支持原糖果题；旧记录仍可查看');
  const question = findSuite(suiteId, suiteVersion)?.questions.find(item => item.id === questionId);
  if (!question) throw invalid('原题集或题目版本不可用');
  return { suiteId, suiteVersion, questionId, questionHash: identityHash(question.prompt), graderId: question.graderId, graderVersion: question.graderVersion,
    prompt: question.prompt, expected: question.expected };
}
export function validateTask(task) {
  const keys = ['suiteId', 'suiteVersion', 'questionId', 'questionHash', 'graderId', 'graderVersion', 'prompt', 'expected', 'options'];
  if (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).some(key => !keys.includes(key)) ||
    !['suiteId', 'suiteVersion', 'questionId', 'graderId', 'graderVersion'].every(key => typeof task[key] === 'string' && task[key].length > 0 && task[key].length <= 120) ||
    !/^[a-f0-9]{64}$/.test(task.questionHash || '') || typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 12000 || identityHash(task.prompt) !== task.questionHash ||
    !(Number.isFinite(task.expected) || typeof task.expected === 'string' && task.expected.length > 0 && task.expected.length <= 40) ||
    task.options != null && (!Array.isArray(task.options) || task.options.length < 1 || task.options.length > 20 || task.options.some(x => typeof x !== 'string' || !x || x.length > 40))) throw invalid('题目快照格式无效');
  return structuredClone(task);
}
export function assertTaskAvailable(task) {
  validateTask(task);
  const supported = taskFor(task.suiteId, task.suiteVersion, task.questionId);
  if (task.graderId !== supported.graderId || task.graderVersion !== supported.graderVersion || task.questionHash !== supported.questionHash ||
    JSON.stringify(task.expected) !== JSON.stringify(supported.expected) || JSON.stringify(task.options || []) !== JSON.stringify(supported.options || [])) throw invalid('原题目或判分器版本依赖不兼容，不能替换为当前题目');
  return structuredClone(task);
}
export function selectTasks(input) {
  if (!input) return [taskFor('shape-choice', '1', 'shape-choice')];
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'version', 'questionIds'].includes(key))) throw invalid('题集选择格式无效');
  const suite = findSuite(input.id, input.version);
  if (!suite) throw invalid('题集版本不可用');
  const ids = input.questionIds || suite.questions.map(q => q.id);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !suite.questions.some(q => q.id === id))) throw invalid('题目选择无效或重复');
  return ids.map(id => taskFor(suite.id, suite.version, id));
}
export function readGrade(run) {
  return run.grade || (run.kind === 'candy' && run.candy ? { verdict: run.candy.verdict, answer: run.candy.answer ?? null, expected: run.candy.expected ?? null } : null);
}
export function gradeTask(task, content, finishReason) {
  assertTaskAvailable(task);
  const result = classifyCandy(content, finishReason);
  return { ...result, grade: { verdict: result.candy.verdict, answer: result.candy.answer, expected: result.candy.expected } };
}
