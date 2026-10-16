// 紙にインクがにじむ簡易シミュレーション。1 マス = 1 CSS px。
// 水が繊維のむら（k）に沿って広がり、顔料は水に運ばれ、乾くほど紙に定着する。
(() => {
  const canvas = document.getElementById("ink");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let lines = JSON.parse(canvas.dataset.lines);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dark = matchMedia("(prefers-color-scheme: dark)");

  const PAD = 24, LH = 56;
  // 調整つまみ。?tune を付けて開くとスライダーで変えられる
  const P = {
    writeSeconds: 3.2,  // 全部書き終えるまでの秒数
    fiberMin: 0.03,     // 繊維の吸い込みやすさの下限（0.25 以下）
    fiberRange: 0.21,   // 繊維のむらの幅（fiberMin + fiberRange ≦ 0.25）
    textWater: 0.06,    // 字に含ませる水。多いほど字がにじむ
    textInk: 0.8,       // 字の顔料
    dropRadius: 7,      // 押したときの滴の半径（px）
    dropWater: 5,
    dropInk: 1.6,
    strokeWater: 0.5,   // なぞったときの水
    strokeInk: 0.6,
    dryRate: 0.992,     // 1 ステップで残る水の割合。1 に近いほど長く濡れて広がる
    settle: 0.004,      // 濡れている間に顔料が紙に定着する速さ
    darkness: 3.2,      // インクの濃さ
    steps: 3,           // 1 フレームあたりの計算回数。多いほど速くにじむ
  };
  let W, H, k, water, pig, dep, dW, dP, buf, img, queue, qi, penX, penLine, lineEnds, rgb, running = false;

  function inkColor() {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
    const n = parseInt(v.slice(1), 16);
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function fibers() {
    const C = 6, cw = Math.ceil(W / C) + 2, ch = Math.ceil(H / C) + 2;
    const coarse = Float32Array.from({ length: cw * ch }, Math.random);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const gx = x / C, gy = y / C, x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0;
      const a = coarse[y0 * cw + x0], b = coarse[y0 * cw + x0 + 1], c = coarse[(y0 + 1) * cw + x0], d = coarse[(y0 + 1) * cw + x0 + 1];
      const n = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
      k[y * W + x] = Math.min(0.25, P.fiberMin + P.fiberRange * (0.7 * n + 0.3 * Math.random()));
    }
  }

  async function setup() {
    lines = JSON.parse(canvas.dataset.lines);
    W = Math.floor(canvas.clientWidth);
    H = PAD * 2 + LH * lines.length;
    canvas.style.height = H + "px";
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = W * dpr; canvas.height = H * dpr;
    const n = W * H;
    k = new Float32Array(n); water = new Float32Array(n); pig = new Float32Array(n); dep = new Float32Array(n);
    dW = new Float32Array(n); dP = new Float32Array(n);
    buf = new OffscreenCanvas(W, H); img = buf.getContext("2d").createImageData(W, H);
    fibers(); inkColor();

    const size = Math.min(26, Math.max(18, W / 18));
    const font = `${size}px "Klee One"`;
    await Promise.race([document.fonts.load(font), new Promise((r) => setTimeout(r, 1500))]);
    const m = new OffscreenCanvas(W, H).getContext("2d", { willReadFrequently: true });
    m.font = font; m.textBaseline = "alphabetic";
    lines.forEach((t, i) => m.fillText(t, PAD, PAD + LH * (i + 1) - 14));
    const a = m.getImageData(0, 0, W, H).data;

    // ペンで書く順（行ごとに左から右）に並べる
    queue = []; lineEnds = [];
    for (let li = 0; li < lines.length; li++) {
      const top = PAD + LH * li, px = [];
      let end = 0;
      for (let y = top; y < top + LH && y < H; y++) for (let x = 0; x < W; x++) {
        const al = a[(y * W + x) * 4 + 3];
        if (al > 30) { px.push([x, y, al / 255, li]); if (x > end) end = x; }
      }
      px.sort((p, q) => p[0] - q[0]);
      queue.push(...px); lineEnds.push(end);
    }
    qi = 0; penX = PAD; penLine = 0;
  }

  function drop(x, y, r, w, p) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const X = x + dx, Y = y + dy, d = Math.hypot(dx, dy) / r;
      if (X < 1 || Y < 1 || X >= W - 1 || Y >= H - 1 || d > 1) continue;
      const i = Y * W + X, f = 1 - d * d;
      water[i] += w * f; pig[i] += p * f;
    }
  }

  function write(dt) {
    if (penLine >= lines.length) return;
    const total = lineEnds.reduce((s, e) => s + e - PAD, 0);
    penX += total * dt / P.writeSeconds;
    while (qi < queue.length) {
      const [x, y, al, li] = queue[qi];
      if (li > penLine || x > penX) break;
      const i = y * W + x;
      water[i] += P.textWater * al; pig[i] += P.textInk * al; qi++;
    }
    if (penX > lineEnds[penLine]) { penLine++; penX = PAD; }
  }

  function flow(i, j, wi) {
    const f = Math.min(k[i], k[j]) * (wi - water[j]);
    const pm = f > 0 ? f * pig[i] / (wi + 1e-6) : f * pig[j] / (water[j] + 1e-6);
    dW[i] -= f; dW[j] += f; dP[i] -= pm; dP[j] += pm;
  }

  function step() {
    dW.fill(0); dP.fill(0);
    let wet = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, wi = water[i];
      if (wi < 1e-4 && water[i + 1] < 1e-4 && water[i + W] < 1e-4) continue;
      wet++;
      flow(i, i + 1, wi);
      flow(i, i + W, wi);
    }
    for (let i = 0; i < water.length; i++) {
      let w = water[i] + dW[i];
      const p = pig[i] + dP[i];
      if (w <= 0 && p <= 0) { water[i] = 0; pig[i] = 0; continue; }
      w = Math.max(0, w * P.dryRate - 0.0006);
      const d = w === 0 ? p : p * (P.settle + 0.3 * Math.max(0, 1 - w / 0.08));
      water[i] = w; pig[i] = p - d; dep[i] += d;
    }
    return wet;
  }

  function render() {
    const o = img.data, [r, g, b] = rgb;
    for (let i = 0, j = 0; i < dep.length; i++, j += 4) {
      const v = dep[i] + pig[i] * 0.5;
      o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = 255 * (1 - Math.exp(-P.darkness * v));
    }
    buf.getContext("2d").putImageData(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buf, 0, 0, canvas.width, canvas.height);
  }

  let prev = 0;
  function loop(t) {
    write(Math.min(0.05, prev ? (t - prev) / 1000 : 1 / 60));
    prev = t;
    let wet = 0;
    for (let s = 0; s < P.steps; s++) wet += step();
    render();
    if (wet > 0 || penLine < lines.length) requestAnimationFrame(loop);
    else { running = false; prev = 0; }
  }
  function wake() { if (!running) { running = true; requestAnimationFrame(loop); } }

  async function start() {
    await setup();
    if (reduce) {
      while (penLine < lines.length) { penX = Infinity; write(0); }
      for (let s = 0; s < 400 && step() > 0; s++);
      render();
      return;
    }
    wake();
  }

  let last = null;
  const at = (e) => { const r = canvas.getBoundingClientRect(); return [Math.round(e.clientX - r.left), Math.round(e.clientY - r.top)]; };
  canvas.addEventListener("pointerdown", (e) => {
    if (reduce) return;
    last = at(e); drop(...last, P.dropRadius, P.dropWater, P.dropInk); wake();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!last || reduce) return;
    const [x, y] = at(e), n = Math.max(1, Math.ceil(Math.hypot(x - last[0], y - last[1]) / 2));
    for (let s = 1; s <= n; s++) drop(Math.round(last[0] + (x - last[0]) * s / n), Math.round(last[1] + (y - last[1]) * s / n), 2, P.strokeWater, P.strokeInk);
    last = [x, y]; wake();
  });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) canvas.addEventListener(t, () => (last = null));

  document.getElementById("rewrite")?.addEventListener("click", start);
  dark.addEventListener("change", () => { inkColor(); render(); });
  new MutationObserver(() => { inkColor(); render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  let rw;
  addEventListener("resize", () => {
    if (Math.floor(canvas.clientWidth) === W) return;
    clearTimeout(rw); rw = setTimeout(start, 200);
  });

  if (new URLSearchParams(location.search).has("tune")) tunePanel();

  function tunePanel() {
    const ranges = {
      writeSeconds: [0.5, 10, 0.1], fiberMin: [0, 0.25, 0.005], fiberRange: [0, 0.25, 0.005],
      textWater: [0, 0.5, 0.01], textInk: [0.1, 2, 0.05], dropRadius: [1, 20, 1], dropWater: [0, 15, 0.1], dropInk: [0, 4, 0.05],
      strokeWater: [0, 3, 0.05], strokeInk: [0, 2, 0.05], dryRate: [0.95, 0.999, 0.001], settle: [0, 0.05, 0.001],
      darkness: [0.5, 8, 0.1], steps: [1, 8, 1],
    };
    const box = document.createElement("div");
    box.dataset.tune = "";
    box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9;width:260px;max-height:80vh;overflow:auto;padding:12px;background:var(--surface);border:1px solid var(--ink);font:12px/1.4 var(--font-sans);";
    for (const [key, [min, max, stepSize]] of Object.entries(ranges)) {
      const row = document.createElement("label");
      row.style.cssText = "display:block;margin-bottom:6px;";
      row.innerHTML = `<span style="display:flex;justify-content:space-between"><span>${key}</span><output>${P[key]}</output></span>`;
      const input = Object.assign(document.createElement("input"), { type: "range", min, max, step: stepSize, value: P[key] });
      input.style.width = "100%";
      input.oninput = () => { P[key] = Number(input.value); row.querySelector("output").textContent = input.value; if (key === "darkness") render(); };
      row.append(input); box.append(row);
    }
    const copy = Object.assign(document.createElement("button"), { type: "button", textContent: "値をコピー" });
    copy.onclick = () => navigator.clipboard.writeText(JSON.stringify(P, null, 2));
    const note = Object.assign(document.createElement("p"), { textContent: "fiber と字の値は「もう一度書く」で反映" });
    note.style.cssText = "margin:4px 0 8px;color:var(--ink-muted)";
    box.append(note, copy);
    document.body.append(box);
  }

  new IntersectionObserver((es, o) => {
    if (es[0].isIntersecting) { o.disconnect(); start(); }
  }, { threshold: 0.4 }).observe(canvas);
})();
