// 水面に落ちたインクを上から見たアニメーション（WebGL2 の流体シミュレーション）。
// 手順は Stable Fluids：渦の強調 → 非圧縮化（圧力を解く）→ 移流。
// 水は縮まないので、そのままだと点から外へ押す流れは消える。落ちた点に一時的な「湧き出し」を置いて、そのぶん外へ広がらせる。
// <canvas id="fluid" data-mode="background"> ならページの背景として使う（リンクやボタン以外のクリックで落とす）。
(() => {
  const canvas = document.getElementById("fluid");
  if (!canvas) return;
  const BG = canvas.dataset.mode === "background";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (BG && reduce) return;
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
    const fb = document.getElementById("fallback");
    if (fb) fb.hidden = false;
    return;
  }

  // 調整つまみ
  const P = {
    simRes: 160,        // 水の動きの解像度（短辺のマス数）
    dyeRes: 900,        // インクの解像度
    pressureIters: 25,
    velocityFade: 0.6,  // 水の勢いが弱まる速さ
    dyeFade: 0.03,      // インクが薄まる速さ
    curl: 14,           // 渦の強さ。大きいほど縁が細かい筋に崩れる
    spread: 1800,       // 落ちた点から広がる強さ
    spreadFade: 0.93,   // 広がる力が 1 ステップで残る割合
    spreadRadius: 0.0008,
    ripple: 70,         // 縁を崩す小さな乱れの強さ
    ink: 0.1,           // 一滴のインクの量
    inkRadius: 0.00005,
    darkness: 3,        // 見た目の濃さ
    maxAlpha: 1,        // いちばん濃いところの不透明度
    stir: 6000,         // マウスの動きが水を動かす強さ
    autoEvery: 4,       // 自動で落とす間隔（秒）
  };

  const VS = `#version 300 es
in vec2 aPos; uniform vec2 texel;
out vec2 vUv, vL, vR, vT, vB;
void main() {
  vUv = aPos * .5 + .5;
  vL = vUv - vec2(texel.x, 0.); vR = vUv + vec2(texel.x, 0.);
  vT = vUv + vec2(0., texel.y); vB = vUv - vec2(0., texel.y);
  gl_Position = vec4(aPos, 0., 1.);
}`;
  const HEAD = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB; out vec4 o;
`;
  const FS = {
    advect: `uniform sampler2D uVel, uSrc; uniform vec2 texel; uniform float dt, fade;
void main() {
  vec2 c = vUv - dt * texture(uVel, vUv).xy * texel;
  o = texture(uSrc, c) / (1. + fade * dt);
}`,
    splat: `uniform sampler2D uTarget; uniform float aspect, radius; uniform vec2 point; uniform vec3 value;
void main() {
  vec2 p = vUv - point; p.x *= aspect;
  o = vec4(texture(uTarget, vUv).xyz + exp(-dot(p, p) / radius) * value, 1.);
}`,
    curl: `uniform sampler2D uVel;
void main() {
  float L = texture(uVel, vL).y, R = texture(uVel, vR).y, T = texture(uVel, vT).x, B = texture(uVel, vB).x;
  o = vec4(.5 * (R - L - T + B), 0., 0., 1.);
}`,
    vorticity: `uniform sampler2D uVel, uCurl; uniform float curl, dt;
void main() {
  float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x, T = texture(uCurl, vT).x, B = texture(uCurl, vB).x, C = texture(uCurl, vUv).x;
  vec2 f = .5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  f = f / (length(f) + 1e-4) * curl * C; f.y *= -1.;
  o = vec4(clamp(texture(uVel, vUv).xy + f * dt, -1e4, 1e4), 0., 1.);
}`,
    divergence: `uniform sampler2D uVel, uSource;
void main() {
  float L = texture(uVel, vL).x, R = texture(uVel, vR).x, T = texture(uVel, vT).y, B = texture(uVel, vB).y;
  vec2 C = texture(uVel, vUv).xy;
  if (vL.x < 0.) L = -C.x; if (vR.x > 1.) R = -C.x; if (vT.y > 1.) T = -C.y; if (vB.y < 0.) B = -C.y;
  o = vec4(.5 * (R - L + T - B) - texture(uSource, vUv).x, 0., 0., 1.);
}`,
    scale: `uniform sampler2D uSrc; uniform float k;
void main() { o = k * texture(uSrc, vUv); }`,
    pressure: `uniform sampler2D uP, uDiv;
void main() {
  float L = texture(uP, vL).x, R = texture(uP, vR).x, T = texture(uP, vT).x, B = texture(uP, vB).x;
  o = vec4((L + R + T + B - texture(uDiv, vUv).x) * .25, 0., 0., 1.);
}`,
    gradient: `uniform sampler2D uP, uVel;
void main() {
  float L = texture(uP, vL).x, R = texture(uP, vR).x, T = texture(uP, vT).x, B = texture(uP, vB).x;
  o = vec4(texture(uVel, vUv).xy - vec2(R - L, T - B), 0., 1.);
}`,
    display: `uniform sampler2D uDye; uniform vec3 bg, ink; uniform float darkness, maxAlpha;
void main() {
  float d = max(texture(uDye, vUv).r, 0.);
  o = vec4(mix(bg, ink, maxAlpha * (1. - exp(-darkness * d))), 1.);
}`,
  };

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const vs = shader(gl.VERTEX_SHADER, VS);
  const progs = {};
  for (const [name, src] of Object.entries(FS)) {
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, HEAD + src));
    gl.bindAttribLocation(p, 0, "aPos"); gl.linkProgram(p);
    const u = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const n = gl.getActiveUniform(p, i).name;
      u[n] = gl.getUniformLocation(p, n);
    }
    progs[name] = { p, u };
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function target(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }
  const pair = (w, h) => { let a = target(w, h), b = target(w, h); return { get read() { return a; }, get write() { return b; }, swap() { [a, b] = [b, a]; }, w, h }; };

  let vel, dye, pres, src, div, curlT, aspect;
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    aspect = canvas.width / canvas.height;
    const size = (res) => aspect > 1 ? [Math.round(res * aspect), res] : [res, Math.round(res / aspect)];
    const [sw, sh] = size(P.simRes), [dw, dh] = size(P.dyeRes);
    vel = pair(sw, sh); pres = pair(sw, sh); src = pair(sw, sh); div = target(sw, sh); curlT = target(sw, sh); dye = pair(dw, dh);
  }

  let unit = 0;
  function bind(u, tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u, unit++); }
  function run(name, out, uniforms) {
    const { p, u } = progs[name];
    gl.useProgram(p); unit = 0;
    gl.uniform2f(u.texel, 1 / vel.w, 1 / vel.h);
    for (const [k, v] of Object.entries(uniforms)) {
      if (!u[k]) continue;
      if (v && v.tex) bind(u[k], v.tex);
      else if (Array.isArray(v)) gl[`uniform${v.length}f`](u[k], ...v);
      else gl.uniform1f(u[k], v);
    }
    gl.viewport(0, 0, out ? out.w : canvas.width, out ? out.h : canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function add(field, x, y, value, radius) {
    run("splat", field.write, { uTarget: field.read, aspect, radius, point: [x, y], value }); field.swap();
  }

  // 一滴：インクを置き、湧き出しで外へ広げ、縁のまわりに小さな乱れを散らして崩れるきっかけを作る
  function drop(x, y, scale = 1) {
    add(dye, x, y, [P.ink * scale, 0, 0], P.inkRadius * scale);
    add(src, x, y, [P.spread * scale * 0.01, 0, 0], P.spreadRadius * scale);
    const r = Math.sqrt(P.inkRadius * scale) * 1.5;
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, s = P.ripple * (0.5 + Math.random());
      add(vel, x + Math.cos(a) * r / aspect, y + Math.sin(a) * r, [-Math.sin(a) * s, Math.cos(a) * s, 0], 0.0002);
    }
  }

  function step(dt) {
    run("curl", curlT, { uVel: vel.read });
    run("vorticity", vel.write, { uVel: vel.read, uCurl: curlT, curl: P.curl, dt }); vel.swap();
    run("divergence", div, { uVel: vel.read, uSource: src.read });
    run("scale", src.write, { uSrc: src.read, k: P.spreadFade }); src.swap();
    run("scale", pres.write, { uSrc: pres.read, k: 0.8 }); pres.swap();
    for (let i = 0; i < P.pressureIters; i++) { run("pressure", pres.write, { uP: pres.read, uDiv: div }); pres.swap(); }
    run("gradient", vel.write, { uP: pres.read, uVel: vel.read }); vel.swap();
    run("advect", vel.write, { uVel: vel.read, uSrc: vel.read, dt, fade: P.velocityFade }); vel.swap();
    run("advect", dye.write, { uVel: vel.read, uSrc: dye.read, dt, fade: P.dyeFade }); dye.swap();
  }

  let colors;
  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const rgb = (name) => { const n = parseInt(css.getPropertyValue(name).trim().slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
    colors = { bg: rgb("--surface"), ink: rgb("--ink") };
  }
  function draw() { run("display", null, { uDye: dye.read, bg: colors.bg, ink: colors.ink, darkness: P.darkness, maxAlpha: P.maxAlpha }); }

  let t = 0, nextAuto = 0;
  function auto() {
    if (t < nextAuto) return;
    nextAuto = t + P.autoEvery * (0.7 + Math.random() * 0.6);
    drop(0.2 + Math.random() * 0.6, 0.2 + Math.random() * 0.6, 0.7 + Math.random() * 0.6);
  }

  let last = 0, running = false;
  function frame(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now; t += dt;
    auto();
    step(dt);
    draw();
    requestAnimationFrame(frame);
  }
  function wake() {
    if (!running) { running = true; requestAnimationFrame(frame); }
  }

  // 触れたところにインクを落とす。マウスは押さなくても、動かすだけで水がかき回される（タッチは、押してなぞったとき）
  let pointer = null;
  const uv = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height]; };
  const dropAt = (e) => { drop(...uv(e)); wake(); };
  const stir = (e) => {
    const [x, y] = uv(e);
    // 画面の外から戻ってきたときなど、離れすぎた位置からは流れを作らない
    if (pointer && Math.hypot(x - pointer[0], y - pointer[1]) < 0.2) {
      add(vel, x, y, [(x - pointer[0]) * P.stir, (y - pointer[1]) * P.stir, 0], 0.0003);
      wake();
    }
    pointer = [x, y];
  };
  const hover = (e) => { if (e.pointerType === "mouse" || pointer) stir(e); };
  if (BG) {
    // ページ全体で受ける。リンク・ボタン・紙面のインクの上では落とさない。タップは click で受けるのでスクロールでは落ちない
    const skip = (e) => e.target.closest("a, button, input, textarea, select, label, canvas#ink, [data-tune], [contenteditable]");
    addEventListener("click", (e) => { if (!skip(e)) dropAt(e); });
    addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") stir(e); });
    document.documentElement.addEventListener("pointerleave", () => (pointer = null));
  } else {
    canvas.addEventListener("pointerdown", (e) => { pointer = uv(e); dropAt(e); });
    canvas.addEventListener("pointermove", hover);
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) canvas.addEventListener(ev, (e) => { if (e.type !== "pointerup" || e.pointerType !== "mouse") pointer = null; });
  }

  new MutationObserver(() => { readColors(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); draw(); });
  let rt;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { resize(); draw(); }, 200); });

  readColors();
  resize();
  draw();
  if (reduce) {
    for (let i = 0; i < 240; i++) { t += 1 / 60; auto(); step(1 / 60); }
    draw();
  } else {
    running = true;
    requestAnimationFrame(frame);
  }
  window.inkFluid = P;

  if (new URLSearchParams(location.search).has("tune")) tunePanel();

  // ?tune を付けて開くと、左下にスライダーが出る。動かすとすぐ反映される
  function tunePanel() {
    const ranges = {
      ink: [0.1, 5, 0.05], inkRadius: [0.00005, 0.002, 0.00005], spread: [0, 6000, 50], spreadRadius: [0.0001, 0.004, 0.0001],
      spreadFade: [0.5, 0.99, 0.01], ripple: [0, 400, 5], curl: [0, 50, 1], velocityFade: [0, 3, 0.05],
      dyeFade: [0, 1, 0.01], darkness: [0.5, 8, 0.1], maxAlpha: [0.05, 1, 0.05], autoEvery: [1, 15, 0.5], stir: [0, 20000, 250],
    };
    const box = document.createElement("div");
    box.dataset.tune = "";
    box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9;width:260px;max-height:80vh;overflow:auto;padding:12px;background:var(--surface);color:var(--ink);border:1px solid var(--ink);font:12px/1.4 var(--font-sans);";
    box.innerHTML = '<p style="margin:0 0 8px;font-weight:500">水のインク</p>';
    for (const [key, [min, max, stepSize]] of Object.entries(ranges)) {
      const row = document.createElement("label");
      row.style.cssText = "display:block;margin-bottom:6px;";
      row.innerHTML = `<span style="display:flex;justify-content:space-between"><span>${key}</span><output>${P[key]}</output></span>`;
      const input = Object.assign(document.createElement("input"), { type: "range", min, max, step: stepSize, value: P[key] });
      input.style.width = "100%";
      input.oninput = () => { P[key] = Number(input.value); row.querySelector("output").textContent = input.value; draw(); };
      row.append(input); box.append(row);
    }
    const copy = Object.assign(document.createElement("button"), { type: "button", textContent: "値をコピー" });
    copy.onclick = () => navigator.clipboard.writeText(JSON.stringify(Object.fromEntries(Object.keys(ranges).map((k) => [k, P[k]])), null, 2));
    box.append(copy);
    document.body.append(box);
  }
})();
