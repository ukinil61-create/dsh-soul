// 灵魂的光：几千颗粒子，按形态聚成一团光、一个光点形象，或散到屏幕四周。
// 状态由颜色和形状表达，这里不知道对话内容。形象的走向由 figure-engine.js 决定。

(() => {
  const TAU = Math.PI * 2;
  const COLOR = {
    idle: [150, 170, 255], listen: [188, 202, 255], hear: [110, 240, 215], think: [190, 160, 255], speak: [186, 208, 255],
    linger: [186, 208, 255], work: [255, 186, 104], done: [140, 232, 186], alert: [255, 240, 225],
  };
  const PARTICLES = window.SoulFigure.MAX_PARTICLES;
  const ALPHA_LEVELS = [.42, .72, 1];
  const GLOW_ALPHA = .07;
  const GLOW_RADIUS = 4.5;
  /** 没有动静时降到 30 帧，省电 */
  const IDLE_FRAME_MS = 33;
  /** 睡着时暗多少、慢多少 */
  const REST_DIM = .55;
  const REST_SLOW = .7;
  /** 监听时围着形象的光环：多少颗粒子里抽一颗、宽高占形象高度多少、多大声算满 */
  const HALO_EVERY = 4;
  const HALO_RX = .44;
  const HALO_RY = .5;
  const LOUD_RMS = .08;
  /**
   * 每个状态长什么样：figure 聚成形象（否则是待机的样子），ring 外面围一圈光，spin 是这圈转多快。
   * present：一有动静就是她，光环只代表麦克风开着。sayOnly：只有开口才聚成形象，其余靠外圈分状态。用户在设置里选
   */
  const SPEAKING_LOOKS = { speak: { figure: true }, linger: { figure: true }, done: { figure: true }, alert: { figure: true } };
  const LOOKS = {
    present: {
      idle: {}, listen: { figure: true }, think: { figure: true }, work: { figure: true },
      hear: { figure: true, ring: true, spin: .1 }, ...SPEAKING_LOOKS,
    },
    sayOnly: {
      idle: {}, listen: {}, think: { ring: true, spin: .5 }, work: { ring: true, spin: 1.6 },
      hear: { ring: true, spin: .1 }, ...SPEAKING_LOOKS,
    },
  };

  /**
   * 待机时一颗粒子该在哪：灵魂用 soul_set_idle 决定形状。
   * 返回相对中心的 [x, y, 亮度]。a、b、c 是这颗粒子固定的随机数，r 是集群半径。
   */
  const out = [0, 0, 0];
  function idleTarget(a, b, c, i, t, r, idle) {
    let x, y, al = .22 + .5 * (1 - a);
    switch (idle.shape) {
      case 'ring': {
        const ang = b * TAU + t * (.05 + .1 * c);
        const d = r * (1 + (a - .5) * .22 + .04 * Math.sin(5 * ang + t));
        x = Math.cos(ang) * d; y = Math.sin(ang) * d;
        al = .3 + .5 * (1 - Math.abs(a - .5) * 2);
        break;
      }
      case 'spiral': {
        const d = Math.sqrt(a);
        const ang = d * 11 + t * .25 + (i % 2) * Math.PI;
        const spread = (c - .5) * r * .12;
        x = Math.cos(ang) * (d * r + spread); y = Math.sin(ang) * (d * r + spread);
        break;
      }
      case 'galaxy': {
        const d = Math.pow(a, 1.6);
        const arm = (i % 3) * TAU / 3;
        const ang = arm + d * 6 + t * (.06 + .2 * (1 - d)) + (c - .5) * .7;
        x = Math.cos(ang) * d * r * 1.25; y = Math.sin(ang) * d * r * .55;
        al = .25 + .7 * (1 - d);
        break;
      }
      case 'wave': {
        const u = b * 2 - 1;
        x = u * r * 1.5;
        y = Math.sin(u * 5 + t * .9) * r * .32 + Math.sin(u * 2.3 - t * .5 + c * 2) * r * .14 + (a - .5) * r * .22;
        break;
      }
      case 'heart': {
        const ang = b * TAU;
        const fill = Math.sqrt(a) * (1 + .03 * Math.sin(t * 2));
        x = 16 * Math.sin(ang) ** 3 * fill * r / 15;
        y = -(13 * Math.cos(ang) - 5 * Math.cos(2 * ang) - 2 * Math.cos(3 * ang) - Math.cos(4 * ang)) * fill * r / 15;
        break;
      }
      case 'star': {
        const ang = b * TAU + t * .04;
        const spike = Math.abs(((ang / TAU * 5) % 1 + 1) % 1 - .5) * 2;
        const d = r * Math.sqrt(a) * (.42 + .58 * spike);
        x = Math.cos(ang) * d; y = Math.sin(ang) * d;
        break;
      }
      case 'swarm': {
        const k = t * (.2 + .5 * c);
        x = (Math.sin(k + b * 40) + Math.sin(k * .37 + a * 31)) * r * .62;
        y = (Math.cos(k * .8 + a * 53) + Math.sin(k * .53 + c * 23)) * r * .62;
        break;
      }
      case 'rain': {
        const fall = ((a + t * (.05 + .1 * c)) % 1);
        x = (b - .5) * r * 2.6; y = (fall - .5) * r * 2.2;
        al = .15 + .6 * Math.sin(fall * Math.PI);
        break;
      }
      case 'points': {
        const list = idle.points;
        if (list && list.length) {
          const p = list[i % list.length];
          const ang = b * TAU + t * .3 * (c - .5);
          const d = a * a * r * .09;
          x = p[0] * r + Math.cos(ang) * d; y = p[1] * r + Math.sin(ang) * d;
          al = .4 + .5 * (1 - a);
          break;
        }
      }
      // 没给点就回到默认的一团
      // falls through
      default: {
        const ang = b * TAU + t * (.04 + .12 * c);
        const d = r * Math.pow(a, .9) * (1 + .09 * Math.sin(3 * ang + t * .7) + .05 * Math.sin(5 * ang - t * .4));
        x = Math.cos(ang) * d; y = Math.sin(ang) * d * .94;
      }
    }
    out[0] = x; out[1] = y; out[2] = al;
    return out;
  }

  window.createLight = function createLight(canvas, options) {
    const ctx = canvas.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const X = new Float32Array(PARTICLES), Y = new Float32Array(PARTICLES), A = new Float32Array(PARTICLES);
    const S1 = new Float32Array(PARTICLES), S2 = new Float32Array(PARTICLES), S3 = new Float32Array(PARTICLES);
    for (let i = 0; i < PARTICLES; i++) { S1[i] = Math.random(); S2[i] = Math.random(); S3[i] = Math.random(); A[i] = .4; }

    let figure = window.SoulFigure.compile(window.SoulFigurePresets[0]);
    const aim = { shape: 'blob', cx: options.cx, cy: options.cy, scale: options.scale, energy: .35, col: COLOR.idle, speaking: false, rest: 0, ring: false, spin: 0, level: 0 };
    const cur = { cx: aim.cx, cy: aim.cy, scale: aim.scale, energy: .35, r: 150, g: 170, b: 255, edge: 0, core: 1, figure: 0, rest: 0, level: 0 };
    let W = 0, H = 0, bottomInset = 0, last = 0, drawnAt = 0, blink = 1, nextBlink = 3, idlePhase = 0, ringPhase = 0, resting = false;
    let looks = LOOKS.present;
    const idle = { shape: 'cloud', points: null, color: COLOR.idle, size: 1, speed: 1 };
    const placed = [0, 0, 0, 0, false];

    function resize() {
      const first = !W;
      W = canvas.clientWidth || innerWidth; H = canvas.clientHeight || innerHeight;
      if (!W || !H) return;
      bottomInset = options.contained ? 0 : Math.max(0, screen.height - screen.availHeight);
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (first) for (let i = 0; i < PARTICLES; i++) { X[i] = W * cur.cx + (S1[i] - .5) * H * .5; Y[i] = H * cur.cy + (S2[i] - .5) * H * .5; }
    }
    if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);
    addEventListener('resize', resize);
    resize();

    const mix = (a, b, k) => a + (b - a) * k;

    function frame(now) {
      requestAnimationFrame(frame);
      if (!W || !H) return;
      const calm = aim.col === idle.color && !aim.speaking;
      if (calm && now - drawnAt < IDLE_FRAME_MS) return;
      drawnAt = now;
      const t = now / 1000;
      const step = Math.min((now - (last || now)) / 16.67, 8); last = now;
      const ease = .035 * step;
      cur.cx = mix(cur.cx, aim.cx, ease); cur.cy = mix(cur.cy, aim.cy, ease);
      cur.scale = mix(cur.scale, aim.scale, ease); cur.energy = mix(cur.energy, aim.energy, ease);
      cur.r = mix(cur.r, aim.col[0], ease); cur.g = mix(cur.g, aim.col[1], ease); cur.b = mix(cur.b, aim.col[2], ease);
      cur.edge = mix(cur.edge, aim.shape === 'edge' ? 1 : 0, ease);
      cur.core = mix(cur.core, aim.shape === 'edge' ? 0 : 1, ease);
      cur.figure = mix(cur.figure, aim.shape === 'figure' ? 1 : 0, ease);
      cur.rest = mix(cur.rest, aim.rest, ease);
      cur.level = mix(cur.level, aim.level, Math.min(1, .25 * step));
      const awake = 1 - REST_DIM * cur.rest;

      const breath = reduce ? .5 : .5 + .5 * Math.sin(t * TAU / 5.5);
      const rgb = `${cur.r | 0},${cur.g | 0},${cur.b | 0}`;
      const cx = cur.cx * W, cy = cur.cy * H, S = H * .22 * cur.scale;
      const floor = H - bottomInset;

      if (t > nextBlink) { nextBlink = t + 3 + Math.random() * 3.5; blink = 0; }
      blink = Math.min(1, blink + .07 * step);
      const eyeOpen = blink >= 1 ? 1 : Math.max(.08, Math.abs(blink - .5) * 1.9);
      const mouth = aim.speaking ? (.45 + .55 * Math.sin(t * 11)) * Math.abs(Math.sin(t * 2.7)) : 0;

      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H);

      if (cur.edge > .01) {
        const band = H * (.09 + .07 * cur.energy + .02 * breath);
        const a = awake * cur.edge * (.13 + .24 * cur.energy + .08 * breath + (aim.speaking ? .1 * mouth : 0));
        const edge = (x0, y0, x1, y1) => {
          const g = ctx.createLinearGradient(x0, y0, x1, y1);
          g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        };
        edge(0, 0, band, 0); edge(W, 0, W - band, 0); edge(0, 0, 0, band); edge(0, floor, 0, floor - band * 1.4);
      }
      if (cur.core > .01) {
        const R = S * (2.1 + .25 * breath);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        g.addColorStop(0, `rgba(${rgb},${awake * cur.core * (.26 + .2 * cur.energy) * (1 - cur.figure * .6)})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
      }

      const figureH = H * figure.height * cur.scale;
      const bob = reduce ? 0 : Math.sin(t * TAU / 4.2) * figureH * .006;
      if (cur.figure > .02) {
        for (const halo of figure.halos) {
          const hx = cx + halo.x * figureH, hy = cy + halo.y * figureH + bob, hr = halo.r * figureH;
          const [r, g, bl] = figure.colors[halo.color].rgb;
          const g2 = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
          g2.addColorStop(0, `rgba(${r},${g},${bl},${.5 * cur.figure * eyeOpen * halo.brightness})`);
          g2.addColorStop(.35, `rgba(${r},${g},${bl},${.12 * cur.figure * eyeOpen * halo.brightness})`);
          g2.addColorStop(1, `rgba(${r},${g},${bl},0)`);
          ctx.fillStyle = g2;
          ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
        }
      }

      ctx.globalCompositeOperation = options.transparent ? 'source-over' : 'lighter';
      const colorCount = figure.colors.length + 1;
      const buckets = Array.from({ length: colorCount }, () => [new Path2D(), new Path2D(), new Path2D(), new Path2D()]);
      // 按屏幕高度算，小窗口里预览和桌面上比例一致
      const size = Math.max(.9, H / 760);
      const blobR = S * (1 + .08 * breath + .1 * cur.energy);
      const perim = 2 * (W + floor);
      const motion = { t: reduce ? 0 : t, eyeOpen, mouth, breath };
      // 累加而不是直接乘时间：改速度或睡着时不会跳一下
      idlePhase += step * .01667 * idle.speed * (1 - REST_SLOW * cur.rest);
      const idleT = idlePhase;
      const idleR = blobR * idle.size;
      const assigned = figure.particles.length;
      ringPhase += step * .01667 * aim.spin;
      for (let i = 0; i < PARTICLES; i++) {
        const a = S1[i], b = S2[i], c = S3[i];
        let tx, ty, al;
        let colorIdx = colorCount - 1;
        let hasGlow = false;
        const inRing = aim.ring && (i % HALO_EVERY === 0 || (aim.shape === 'figure' && i >= assigned));
        if (inRing) {
          // 一部分光点离开形象，围成一圈，声音越大圈越鼓。没有声音时也慢慢呼吸，看得出它醒着
          const ang = b * TAU + ringPhase * (1 + 1.2 * (c - .5));
          const ripple = 1 + (.025 + .03 * breath) * Math.sin(6 * ang + t * 1.6) + cur.level * (.1 + .16 * Math.sin(9 * ang - t * 5));
          const spread = 1 + (a - .5) * .07;
          tx = cx + Math.cos(ang) * figureH * HALO_RX * ripple * spread;
          ty = cy + Math.sin(ang) * figureH * HALO_RY * ripple * spread + bob;
          al = .5 + .4 * (1 - Math.abs(a - .5) * 2) + .1 * cur.level;
          hasGlow = i % (HALO_EVERY * 4) === 0;
        } else if (aim.shape === 'blob') {
          const at = idleTarget(a, b, c, i, idleT, idleR, idle);
          tx = cx + at[0]; ty = cy + at[1];
          al = (at[2] + .2 * cur.energy) * awake;
        } else if (aim.shape === 'figure') {
          if (i < assigned) {
            window.SoulFigure.place(figure, i, motion, placed);
            tx = cx + placed[0] * figureH;
            ty = cy + placed[1] * figureH + bob;
            al = placed[2];
            colorIdx = placed[3];
            hasGlow = placed[4];
          } else {
            // 这个形象用不到的粒子淡出，留在中间等下一次
            tx = cx; ty = cy; al = 0;
          }
        } else {
          const p = ((b + t * .005 * (.4 + c)) % 1) * perim;
          const d = Math.pow(a, 2.4) * H * (.03 + .1 * cur.energy);
          if (p < W) { tx = p; ty = d; }
          else if (p < W + floor) { tx = W - d; ty = p - W; }
          else if (p < 2 * W + floor) { tx = 2 * W + floor - p; ty = floor - d; }
          else { tx = d; ty = perim - p; }
          al = (.12 + .25 * cur.energy) * awake;
        }
        const inFigure = aim.shape === 'figure' && i < assigned && !inRing;
        if (!reduce && !inFigure) { tx += Math.sin(t * 1.3 + i) * .7; ty += Math.cos(t * 1.1 + i * 1.7) * .7; }
        // 聚成形象时跟得更紧，不然流动的线条会糊成一片
        const k = Math.min(1, (inFigure ? .16 + .1 * c : .03 + .06 * c) * step);
        X[i] += (tx - X[i]) * k; Y[i] += (ty - Y[i]) * k;
        A[i] += (al - A[i]) * Math.min(1, .05 * step);
        const v = A[i];
        if (v < .03) continue;
        const level = v < .35 ? 0 : v < .7 ? 1 : 2;
        const rad = (.4 + c * .55) * size;
        const bucket = buckets[colorIdx];
        bucket[level].moveTo(X[i] + rad, Y[i]);
        bucket[level].arc(X[i], Y[i], rad, 0, TAU);
        if (hasGlow) {
          const big = rad * GLOW_RADIUS;
          bucket[3].moveTo(X[i] + big, Y[i]);
          bucket[3].arc(X[i], Y[i], big, 0, TAU);
        }
      }
      // 形象有自己的颜色，再染上一点状态色，这样干活时还是能看出来
      const keep = cur.figure * (1 - figure.tint);
      for (let c = 0; c < colorCount; c++) {
        const base = c < figure.colors.length ? figure.colors[c].rgb : [cur.r, cur.g, cur.b];
        const r = mix(cur.r, base[0], keep) | 0, g = mix(cur.g, base[1], keep) | 0, bl = mix(cur.b, base[2], keep) | 0;
        ALPHA_LEVELS.forEach((alpha, l) => {
          ctx.fillStyle = `rgba(${r},${g},${bl},${alpha})`;
          ctx.fill(buckets[c][l]);
        });
        ctx.fillStyle = `rgba(${r},${g},${bl},${GLOW_ALPHA})`;
        ctx.fill(buckets[c][3]);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    requestAnimationFrame(frame);

    let open = false;
    let lastState = 'idle';
    let lastForm = 'condense';
    return {
      /** 换形象：spec 来自内置方案或工作室保存的设计 */
      setFigure(spec) {
        figure = window.SoulFigure.compile(spec);
      },
      /** 灵魂决定的待机样子 */
      setIdle(value) {
        idle.shape = value?.shape ?? 'cloud';
        idle.points = value?.points ?? null;
        idle.size = value?.size ?? 1;
        idle.speed = value?.speed ?? 1;
        const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value?.color ?? '');
        idle.color = hex ? [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)] : COLOR.idle;
        this.set(lastForm, lastState);
      },
      /** 今天的预算花完了：待机时暗下来、慢下来。一有人找它就照常亮 */
      setRest(value) {
        resting = Boolean(value);
        this.set(lastForm, lastState);
      },
      setLooks(name) {
        looks = LOOKS[name] ?? LOOKS.present;
        this.set(lastForm, lastState);
      },
      /** 麦克风现在有多大声（均方根），只在监听时用 */
      setLevel(rms) {
        aim.level = Math.min(1, rms / LOUD_RMS);
      },
      /** 工作区或会话界面打开时让到左边，变小 */
      setOpen(value) {
        open = value;
        aim.cx = open ? .19 : options.cx;
        aim.cy = open ? .3 : options.cy;
        aim.scale = options.scale * (open ? .6 : 1);
      },
      /** form：condense 光凝成形象，formless 平时无形。state：idle / listen / think / speak / linger / work / done / alert */
      set(form, state) {
        lastForm = form;
        lastState = state;
        const look = looks[state] ?? {};
        aim.ring = Boolean(look.ring);
        aim.spin = look.spin ?? 0;
        if (state !== 'hear') aim.level = 0;
        aim.col = state === 'idle' ? idle.color : COLOR[state] || COLOR.idle;
        aim.speaking = state === 'speak';
        aim.rest = resting && state === 'idle' ? 1 : 0;
        aim.energy = state === 'listen' ? .5 : state === 'work' || state === 'think' ? .7 : look.figure ? .6 : .35;
        // 监听时不管哪种形态都要看得出来：麦克风开着是大事
        if (form === 'formless') aim.shape = state === 'alert' || state === 'hear' ? 'figure' : 'edge';
        else aim.shape = look.figure ? 'figure' : 'blob';
        aim.scale = options.scale * (open ? .6 : aim.shape === 'blob' && state === 'listen' ? .92 : 1);
      },
    };
  };
})();
