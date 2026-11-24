import { DEFAULT_PROMPT } from "../lib/gateway.mjs";
import { CANDY_PROMPT, CANDY_VERSION } from "../lib/candy.mjs";

export const PHASE_HTML = '<!doctype html><html><head><title>合成动画结果</title></head><body style="margin:0;background:#f2f4f8;display:grid;place-items:center;height:100vh"><svg viewBox="0 0 320 180" width="90%"><circle cx="100" cy="128" r="30" fill="none" stroke="#304050" stroke-width="6"/><circle cx="230" cy="128" r="30" fill="none" stroke="#304050" stroke-width="6"/><path d="M100 128l50-55 30 55h-80l36-35h80l14 35" fill="none" stroke="#f80" stroke-width="6"/><ellipse cx="160" cy="57" rx="30" ry="22" fill="white"/><path d="M180 45l43 10-42 12" fill="#fa4"/><circle cx="178" cy="44" r="3"/></svg></body></html>';
export function phaseABoot({ now = Date.now(), count = 6 } = {}) {
  const model = { id: "fixture/one", name: "合成模型 One · 长名称排版检查", provider: "fixture", providerName: "合成供应商", efforts: ["low", "high"], nativeEndpoints: ["/v1/chat/completions"] };
  const time = offset => new Date(now - offset * 60000).toISOString();
  const runs = Array.from({ length: count }, (_, index) => {
    const id = `f1000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, kind = ["pelican", "fingerprint", "candy"][index % 3];
    const run = { id, batchId: id, kind, source: "manual", model: model.id, modelName: model.name, provider: model.provider, providerName: model.providerName,
      createdAt: time(index + 10), startedAt: time(index + 9), finishedAt: time(index + 8), status: index === 3 ? "error" : "completed",
      maxTokens: 64000, concurrency: kind === "pelican" ? 2 : 3, timeoutMs: 600000, effort: "high", elapsedMs: 1234, firstContentMs: 500,
      prompt: kind === "candy" ? CANDY_PROMPT : DEFAULT_PROMPT, content: kind === "pelican" ? PHASE_HTML : kind === "candy" ? "最终答案是 21" : "",
      reasoning: "合成思考，用于布局验证。", html: kind === "pelican" && index !== 3 ? PHASE_HTML : "", hasHTML: kind === "pelican" && index !== 3,
      usage: { prompt_tokens: 40, completion_tokens: 120, total_tokens: 160 }, error: index === 3 ? "合成的可恢复错误" : "" };
    if (kind === "candy") run.candy = { version: CANDY_VERSION, expected: 21, answer: 21, verdict: "match" };
    if (kind === "fingerprint") {
      run.challenges = Array.from({ length: 3 }, () => ({ prompt: "合成数字采样", expected_count: 320 }));
      run.samples = Array.from({ length: 3 }, () => ({ state: "complete", text: "12, 340", raw_text: "12, 340", count: 320, expected_count: 320, first_byte_ms: 500, elapsed_ms: 1234, error: null }));
      run.fingerprint = { completed: 3, valid: 3, prediction: "合成参考模型", probability: .8, samples: run.samples.map(s => ({ state: s.state, count: s.count, expectedCount: s.expected_count })) };
      run.api = "chat_completions"; run.requestedApi = "auto"; run.strict = false; run.serviceTier = "default"; run.revision = 0;
    }
    return run;
  });
  return { version: "phase-a-baseline", models: [model], runs, defaultPrompt: DEFAULT_PROMPT, candyPrompt: CANDY_PROMPT, candyVersion: CANDY_VERSION,
    dataDir: "(isolated fixture)", retentionDays: 7, historyTimeZone: "Asia/Shanghai", batchCleanup: true, batchCancel: true, batchExport: true, retestAvailable: true,
    fingerprintAvailable: true, candyAvailable: true, favoritesAvailable: true, favorites: { favorites: [], plans: [], concurrency: 3, maxDailySlots: 24 }, bankStatus: { state: "missing" } };
}
