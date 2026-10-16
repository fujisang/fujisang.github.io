// ?edit を付けて開いたときだけ動く、文言の編集モード。
// 文字をクリックしてその場で書き換え、「変更をコピー」で「元の文 → 新しい文」の一覧を取り出す（ファイルへの反映は別作業）。
(() => {
  if (!new URLSearchParams(location.search).has("edit")) return;

  const targets = [...document.querySelectorAll("header .wordmark, main h1, main h2, main h3, main p, main .label, main .soon, main .caption, footer span")]
    .filter((el) => !el.parentElement.closest("h1, h2, h3, p"));
  const original = new Map();
  for (const el of targets) {
    original.set(el, el.innerText);
    el.contentEditable = "plaintext-only";
    el.spellcheck = false;
    el.style.outline = "1px dashed var(--line-strong)";
    el.style.outlineOffset = "4px";
  }

  const canvas = document.getElementById("ink");
  const hand0 = JSON.parse(canvas.dataset.lines).join("\n");

  const bar = document.createElement("div");
  bar.dataset.tune = "";
  bar.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9;width:300px;padding:12px;background:var(--surface);color:var(--ink);border:1px solid var(--ink);font:12px/1.6 var(--font-sans);";
  bar.innerHTML = `
    <p style="margin:0 0 8px;font-weight:500">編集モード</p>
    <p style="margin:0 0 8px;color:var(--ink-muted)">点線で囲まれた文字は、クリックしてその場で書き換えられます。</p>
    <label style="display:block;margin-bottom:8px">手書きの見本（1 行ずつ）
      <textarea rows="3" style="width:100%;font:inherit;background:var(--surface);color:var(--ink);border:1px solid var(--line-strong);padding:6px"></textarea>
    </label>
    <button type="button" data-act="copy">変更をコピー</button>
    <button type="button" data-act="reset">元に戻す</button>
    <output style="display:block;margin-top:8px;color:var(--ink-muted)"></output>
    <textarea data-result readonly rows="6" hidden style="width:100%;margin-top:8px;font:inherit;background:var(--surface-raised);color:var(--ink);border:1px solid var(--line-strong);padding:6px"></textarea>`;
  document.body.append(bar);

  const area = bar.querySelector("textarea"), out = bar.querySelector("output"), result = bar.querySelector("[data-result]");
  area.value = hand0;
  let timer;
  area.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      canvas.dataset.lines = JSON.stringify(area.value.split("\n").filter((l) => l.trim()));
      document.getElementById("rewrite").click();
    }, 600);
  });

  function changes() {
    const list = [];
    for (const [el, before] of original) {
      const after = el.innerText;
      if (after.trim() !== before.trim()) list.push(`【元】${before.trim()}\n【新】${after.trim()}`);
    }
    if (area.value.trim() !== hand0.trim()) list.push(`【手書きの見本・元】\n${hand0}\n【手書きの見本・新】\n${area.value.trim()}`);
    return list;
  }

  bar.querySelector('[data-act="copy"]').addEventListener("click", async () => {
    const list = changes();
    if (!list.length) { out.textContent = "変更はまだありません。"; result.hidden = true; return; }
    result.value = list.join("\n\n"); result.hidden = false;
    try {
      await navigator.clipboard.writeText(result.value);
      out.textContent = `${list.length} か所の変更をコピーしました。`;
    } catch {
      result.select();
      out.textContent = `${list.length} か所の変更です。下の欄からコピーしてください。`;
    }
  });
  bar.querySelector('[data-act="reset"]').addEventListener("click", () => {
    for (const [el, before] of original) el.innerText = before;
    area.value = hand0; area.dispatchEvent(new Event("input"));
    result.hidden = true;
    out.textContent = "元に戻しました。";
  });
})();
