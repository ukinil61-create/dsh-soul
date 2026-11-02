// 光点形象引擎。形象不是从图片采样来的，而是几层“光的走向”：线条、光团、眼睛、星点。
// 粒子沿着这些走向分布和流动，所以它看起来是光，不是用点描出来的画。
//
// 形象的数据结构（工作室编辑的就是它）：
//   { name, height, tint, layers: [{ kind, name, color, count, width, points, mirror, closed,
//                                    flow, brightness, twinkle, sway, glow, role, tall }] }
//   坐标以形象高度为 1，原点在中心，x 向右，y 向下。
//   kind：curve 线条 / orb 光团 / eye 眼睛 / stars 星点
//   role：mouth 表示说话时会动

(() => {
  const TAU = Math.PI * 2;
  const LUT_STEPS = 48;
  const MAX_PARTICLES = 3600;

  function gaussian() {
    return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  }

  /** 穿过控制点的平滑曲线，采样成折线 */
  function buildLut(points, closed) {
    const n = points.length;
    if (n < 2) return { xs: [points[0]?.[0] ?? 0], ys: [points[0]?.[1] ?? 0] };
    const at = (i) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
    const segments = closed ? n : n - 1;
    const xs = [];
    const ys = [];
    for (let s = 0; s < segments; s++) {
      const [p0, p1, p2, p3] = [at(s - 1), at(s), at(s + 1), at(s + 2)];
      for (let k = 0; k < LUT_STEPS; k++) {
        const t = k / LUT_STEPS, t2 = t * t, t3 = t2 * t;
        xs.push(.5 * (2 * p1[0] + (p2[0] - p0[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3));
        ys.push(.5 * (2 * p1[1] + (p2[1] - p0[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3));
      }
    }
    if (!closed) { xs.push(points[n - 1][0]); ys.push(points[n - 1][1]); }
    return { xs, ys };
  }

  function hexToRgb(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [190, 208, 255];
  }

  /** 把形象展开成每颗粒子的固定参数。改形象时才调用一次 */
  function compile(spec) {
    const colors = [];
    const colorIndex = (hex) => {
      const key = String(hex).toLowerCase();
      let i = colors.findIndex((c) => c.key === key);
      if (i < 0) { i = colors.length; colors.push({ key, rgb: hexToRgb(hex) }); }
      return i;
    };
    const layers = [];
    const particles = [];
    /** 眼睛后面那团柔光 */
    const halos = [];
    for (const layer of spec.layers ?? []) {
      if (layer.hidden) continue;
      const points = layer.points?.length ? layer.points : [[0, 0]];
      const signs = layer.mirror ? [1, -1] : [1];
      for (const sign of signs) {
        const pts = points.map(([x, y]) => [x * sign, y]);
        const compiled = {
          kind: layer.kind,
          lut: layer.kind === 'curve' ? buildLut(pts, Boolean(layer.closed)) : null,
          pts,
          closed: Boolean(layer.closed),
          width: layer.width ?? .01,
          tall: layer.tall ?? 1.3,
          flow: layer.flow ?? 0,
          brightness: layer.brightness ?? .8,
          twinkle: layer.twinkle ?? .15,
          sway: layer.sway ?? 0,
          glow: Boolean(layer.glow),
          role: layer.kind === 'eye' ? 'eye' : layer.role ?? null,
          color: colorIndex(layer.color),
        };
        const index = layers.push(compiled) - 1;
        if (layer.kind === 'eye') {
          halos.push({ x: pts[0][0], y: pts[0][1], r: compiled.width * 2.4, color: compiled.color, brightness: compiled.brightness });
        }
        const count = Math.round((layer.count ?? 100) / signs.length);
        for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
          particles.push({
            layer: index,
            u: Math.random(),
            off: gaussian(),
            off2: gaussian(),
            rand: Math.random(),
            phase: Math.random() * TAU,
            star: layer.kind === 'stars' ? i % pts.length : 0,
          });
        }
      }
    }
    return { layers, particles, colors, halos, height: spec.height ?? .62, tint: spec.tint ?? .2 };
  }

  /**
   * 第 i 颗粒子此刻的位置和亮度，写进 out：[x, y, 亮度, 颜色序号, 是否带辉光]。
   * 坐标仍以形象高度为 1。motion：{ t, eyeOpen, mouth, breath }
   */
  function place(figure, i, motion, out) {
    const p = figure.particles[i];
    const layer = figure.layers[p.layer];
    const { t } = motion;
    let x;
    let y;
    let fade = 1;
    if (layer.kind === 'curve') {
      const { xs, ys } = layer.lut;
      let u = p.u + layer.flow * t;
      u -= Math.floor(u);
      const pos = u * (xs.length - 1);
      const a = Math.floor(pos);
      const b = Math.min(xs.length - 1, a + 1);
      const k = pos - a;
      const dx = xs[b] - xs[a];
      const dy = ys[b] - ys[a];
      const len = Math.hypot(dx, dy) || 1;
      const spread = p.off * layer.width;
      x = xs[a] + dx * k - (dy / len) * spread;
      y = ys[a] + dy * k + (dx / len) * spread;
      // 流动的线条两头淡出，粒子才像是流进流出，而不是突然出现
      if (layer.flow && !layer.closed) fade = Math.sqrt(Math.sin(u * Math.PI));
    } else if (layer.kind === 'orb') {
      const ang = p.rand * TAU + t * layer.flow;
      const r = Math.sqrt(p.u) * layer.width * (1 + .03 * motion.breath);
      x = layer.pts[0][0] + Math.cos(ang) * r;
      y = layer.pts[0][1] + Math.sin(ang) * r;
    } else if (layer.kind === 'eye') {
      const ang = p.rand * TAU;
      // 越靠中心越密，看起来才是一点光，不是一块碎点
      const r = Math.pow(p.u, 1.5);
      x = layer.pts[0][0] + Math.cos(ang) * r * layer.width;
      y = layer.pts[0][1] + Math.sin(ang) * r * layer.width * layer.tall * motion.eyeOpen;
    } else {
      const star = layer.pts[p.star];
      x = star[0] + p.off * layer.width;
      y = star[1] + p.off2 * layer.width;
    }
    if (layer.role === 'mouth' && layer.lut) {
      const mid = layer.pts[Math.floor(layer.pts.length / 2)][1];
      y += p.off * .012 * motion.mouth + (mid - y) * -.6 * motion.mouth;
    }
    if (layer.sway) {
      const reach = Math.max(0, y + .4);
      x += Math.sin(t * .8 + y * 4) * layer.sway * reach * reach * 4;
    }
    const sparkle = 1 - layer.twinkle + layer.twinkle * (.5 + .5 * Math.sin(t * (1 + 2.4 * p.rand) + p.phase));
    out[0] = x;
    out[1] = y;
    out[2] = layer.brightness * (.6 + .4 * p.rand) * sparkle * fade;
    out[3] = layer.color;
    out[4] = layer.glow;
    return out;
  }

  window.SoulFigure = { compile, place, hexToRgb, MAX_PARTICLES };
})();
