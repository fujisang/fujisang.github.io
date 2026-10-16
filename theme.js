// 白／黒の切り替え。<head> で読み込み、描画前に data-theme を決める（?theme=dark でも指定できる）
(() => {
  const root = document.documentElement;
  const KEY = "kizamu-theme";
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  const t = new URLSearchParams(location.search).get("theme") || saved;
  if (t === "light" || t === "dark") root.dataset.theme = t;

  const current = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const sync = () => document.querySelectorAll("[data-set-theme]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.setTheme === current())));

  addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-set-theme]").forEach((b) => {
      b.addEventListener("click", () => {
        root.dataset.theme = b.dataset.setTheme;
        try { localStorage.setItem(KEY, b.dataset.setTheme); } catch {}
        sync();
      });
    });
    sync();
  });
})();
