import { createHash } from 'node:crypto';

// RYP: historical fixtures remain readable after the three-question feature is removed.
const questions = {
  arithmetic: { prompt: '计算 6 × (8 − 1)。说明计算过程，不使用工具或联网。\n回答最后另起一行，严格使用阿拉伯数字填写：最终答案：N', expected: 42 },
  inventory: { prompt: '仓库原有 9 箱苹果，先发出 4 箱，再收到 7 箱。现在有多少箱苹果？说明计算过程，不使用工具或联网。\n回答最后另起一行，严格使用阿拉伯数字填写：最终答案：N', expected: 12 },
  deduction: { prompt: '已知所有蓝色物件都是金属，盒中的物件是蓝色的。以下哪项一定成立？\nA. 盒中的物件不是金属\nB. 盒中的物件是金属\nC. 所有金属物件都是蓝色的\n说明理由，不使用工具或联网。\n回答最后另起一行，只填写一个选项字母：最终答案：X', expected: 'B', options: ['A', 'B', 'C'] },
};
export function legacyReasoningTask(questionId = 'arithmetic') {
  const question = questions[questionId];
  if (!question) throw Error('Unknown historical fixture');
  return { suiteId: 'reasoning-basics', suiteVersion: '1', questionId, questionHash: createHash('sha256').update(question.prompt).digest('hex'),
    graderId: question.options ? 'finite-enum' : 'exact-number', graderVersion: '1', ...structuredClone(question) };
}
