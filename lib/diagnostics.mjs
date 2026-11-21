const causes = {
  timeout: ["生成超时", "请求未在等待时间内完成。稍后按原条件复测；耗时对比应保留这次超时记录。", "error"],
  "rate-limit": ["请求限流", "供应商限制了请求频率。稍后复测；需要降低并行数时，应作为不同条件的新测试。", "error"],
  authentication: ["认证 / 权限错误", "核对供应商凭据、余额及模型权限，恢复可用后再按原条件复测。", "error"],
  connection: ["响应中断", "连接或流式响应没有正常结束。已有输出保留，可按原条件复测。", "error"],
  storage: ["保存失败", "先检查保存目录权限和磁盘空间，再核对已有输出；确认恢复后再复测。", "error"],
  oversize: ["输出过大", "输出超过保存限制，已有内容保留。调整题面或输出上限会形成新的比较条件。", "error"],
  truncated: ["输出截断", "回答未完整结束。可按原条件复测；增加输出上限会形成新的比较条件。", "warning"],
  route: ["模型路由不符", "实际供应商或模型与选择不符，本次不评分；先核对路由，再复测。", "error"],
  invalid: ["无效输出", "回答不符合本测试的输出要求。查看原始输出，再决定是否按原条件复测。", "error"],
  fingerprint: ["指纹无法评分", "有效采样或参考库证据不足。查看采样错误与原条件，不能据此判断模型身份。", "error"],
  mismatch: ["答案不匹配", "最终数值与预期不符；完整推理仍需人工核对，可选择这类记录复测。", "error"],
  review: ["答案待复核", "未提取到一致的最终数值。先查看完整回答，必要时按原条件复测。", "warning"],
  preview: ["预览运行错误", "HTML 已生成，但当前预览报告运行错误。先查看源码；按原条件复测会重新生成。", "error"],
  "preview-open": ["预览打开失败", "生成结果保留。先核对浏览器打开错误，或在详情里重新查看预览。", "warning"],
  load: ["结果读取失败", "先点击重试读取，恢复已有结果；读取失败不代表模型生成失败。", "warning", false],
  interrupted: ["测试已中断", "服务关闭或重启导致测试中断。已有输出保留，可按原条件复测。", "warning"],
  cancelled: ["测试已取消", "这是主动停止的记录，不计入近期趋势；需要时可以明确选择它复测。", "muted", false],
  request: ["请求失败", "没有足够信息确定更具体的原因。查看原始错误并核对供应商设置，再按原条件复测。", "error"],
};

const info = code => {
  const [label, advice, tone, abnormal = true] = causes[code];
  return { code, label, advice, tone, abnormal };
};

export function failureInfo(run, { previewError = "", loadError = "" } = {}) {
  if (!run || ["queued", "running"].includes(run.status)) return null;
  if (run.status === "completed" && loadError) return info("load");
  if (run.status === "completed" && previewError) return info(/预览运行错误/.test(previewError) ? "preview" : "preview-open");
  if (run.status === "cancelled") return info("cancelled");
  if (run.status === "interrupted") return info("interrupted");
  if (run.diagnostic && Object.hasOwn(causes, run.diagnostic.code)) return info(run.diagnostic.code);
  const samples = Array.isArray(run.samples) ? run.samples.filter(sample => sample && typeof sample === "object") : [];
  const error = [run.error, ...samples.map(sample => sample.error)].filter(value => typeof value === "string").join("\n");
  if (run.status === "error") {
    if (/保存失败|EACCES|ENOSPC|磁盘空间/i.test(error)) return info("storage");
    if (/超过\s*4\s*MiB|输出超过.*限制|输出过大/i.test(error)) return info("oversize");
    if (run.fingerprint?.mismatch || samples.some(sample => sample.provenance?.mismatch) || /路由.*不一致|路由.*不符/.test(error)) return info("route");
    if (/HTTP\s*429\b|rate[ _-]?limit|too many requests|限流|请求频率/i.test(error)) return info("rate-limit");
    if (/HTTP\s*(?:408|504)\b|time[ _-]?out|timed?\s+out|超时/i.test(error)) return info("timeout");
    if (/HTTP\s*(?:401|403)\b|unauthorized|forbidden|认证失败|权限不足/i.test(error)) return info("authentication");
    if (/结束标志之前断开|ECONNRESET|ENOTFOUND|fetch failed|socket|连接.*(?:断开|失败)|network error/i.test(error)) return info("connection");
    if (samples.some(sample => sample.state === "truncated") && !samples.some(sample => sample.state === "failed")) return info("truncated");
    if (run.kind === "fingerprint" && /有效采样|严格模式|评分失败|有效回答不足/.test(error)) return info("fingerprint");
    return info("request");
  }
  if (run.status === "truncated") return info("truncated");
  if (run.status === "invalid") return info(run.kind === "fingerprint" ? "fingerprint" : "invalid");
  if (run.status === "completed" && run.kind === "candy") {
    if (run.candy?.verdict === "mismatch") return info("mismatch");
    if (run.candy?.verdict === "review") return info("review");
  }
  return null;
}
