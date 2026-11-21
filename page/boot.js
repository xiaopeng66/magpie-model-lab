(() => {
  let retry;
  const recover = message => {
    const status = document.getElementById("status"); if (!status) return;
    status.textContent = message;
    if (!retry) { retry = document.createElement("button"); retry.type = "button"; retry.textContent = "重试"; retry.onclick = () => location.reload(); status.after(retry); }
  };
  const timer = setTimeout(() => recover("连接尚未就绪，请重试。"), 6000);
  (async () => {
  const theme = await window.magpie.ready;
  document.documentElement.dataset.theme = theme?.dark ? "dark" : "light";
  const options = await window.magpie.options.get();
  const configured = Number(options?.port);
  const port = Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : 3489;
  const service = window.magpie.service;
  const target = service ? new URL(service, location.href) : new URL(`http://127.0.0.1:${port}/`);
  let providerAction = null;
  window.magpie.onAction?.((action) => {
    if (action?.id !== "fingerprint") return;
    providerAction = action.provider;
    target.searchParams.set("view", "fingerprint"); target.searchParams.set("mode", "fingerprint");
    if (providerAction?.id) target.searchParams.set("provider", providerAction.id);
    location.replace(target.href);
  });
  if (window.magpie.context?.provider?.id) {
    target.searchParams.set("provider", window.magpie.context.provider.id);
    target.searchParams.set("view", "fingerprint"); target.searchParams.set("mode", "fingerprint");
  }
  target.searchParams.set("theme", theme?.dark ? "dark" : "light");
  target.searchParams.set("lang", theme?.lang || "zh");
  location.replace(target.href);
  })().catch(() => { clearTimeout(timer); recover("连接失败，请重新开启插件或重试。"); });
})();
