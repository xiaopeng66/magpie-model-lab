export const CANDY_VERSION = "shape-choice-v1";
export const CANDY_PROMPT = `袋子里有三种口味、两种形状的糖果。
圆形：苹果味 7 个、桃子味 9 个、西瓜味 8 个；
五角星形：苹果味 7 个、桃子味 6 个、西瓜味 4 个。
每次可以靠手感选择要取的形状，但取出前不能分辨口味；取出后可以识别口味，并据此决定下一次选哪种形状。取出的糖果不放回。
要保证手中至少有一对“圆形苹果味 + 五角星桃子味”或“圆形桃子味 + 五角星苹果味”，最少需要预先允许取出多少个糖果？
请给出能保证成功的策略，并说明为什么更少不够。不使用工具或联网。
回答最后另起一行，严格使用阿拉伯数字填写：最终答案：N`;

export function classifyCandy(content, finishReason) {
  const candy = { version: CANDY_VERSION, expected: 21, verdict: "review", answer: null };
  if (finishReason === "length" || finishReason === "max_tokens") return { status: "truncated", html: "", error: "回答被截断，未判定答案", candy: { ...candy, verdict: "incomplete" } };
  if (!["stop", "end_turn"].includes(finishReason) || !content?.trim()) return { status: "error", html: "", error: "没有收到完整的最终回答", candy: { ...candy, verdict: "incomplete" } };
  const conclusions = content.split(/\r?\n/).map(line => line.trim().replace(/\*\*|__/g, "")).filter(line => /^最终答案\s*[:：]/u.test(line));
  const answers = conclusions.map(line => /^最终答案\s*[:：]\s*([+-]?\d+(?:\.\d+)?)\s*(?:颗|个)?\s*[。.!！]?$/u.exec(line)?.[1]);
  if (answers.length && answers.every(value => value !== undefined && Number.isFinite(Number(value))) && new Set(answers.map(Number)).size === 1) {
    candy.answer = Number(answers[0]); candy.verdict = candy.answer === candy.expected ? "match" : "mismatch";
  }
  return { status: "completed", html: "", error: "", candy };
}
