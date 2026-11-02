// 光点形象工作室。桌面上由外壳打开，存到本机；放到网页里时只能预览和存在浏览器。

(() => {
  const $ = (id) => document.getElementById(id);
  const host = window.soulHost ?? null;
  const SCALE = 1;
  const CENTER = { x: .5, y: .47 };
  const HANDLE_R = 6;
  const LOCAL_KEY = 'soul-figures';
  const MAX = window.SoulFigure.MAX_PARTICLES;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const stage = $('stage');
  const handles = $('handles');
  const light = window.createLight(stage, { cx: CENTER.x, cy: CENTER.y, scale: SCALE, transparent: false, contained: true });
  let previewState = 'linger';

  let figure = clone(window.SoulFigurePresets[0]);
  let source = { kind: 'preset', id: figure.id };
  let active = null;
  let saved = [];
  let selected = 0;
  const history = [];

  // ---- 存取：桌面走外壳，网页走浏览器 ----

  function localList() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY)) ?? [];
    } catch {
      return [];
    }
  }

  function localWrite(list) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
    } catch {
      /* 浏览器不让存：这次改的只留在页面上 */
    }
    return { saved: list, active: null };
  }

  const store = host ? {
    list: () => host.figuresList(),
    save: (spec) => host.figureSave(spec),
    remove: (name) => host.figureDelete(name),
    use: (choice) => host.figureUse(choice),
  } : {
    list: async () => ({ saved: localList(), active: null }),
    save: async (spec) => localWrite([...localList().filter((item) => item.name !== spec.name), spec]),
    remove: async (name) => localWrite(localList().filter((item) => item.name !== name)),
    use: null,
  };

  function say(text) {
    $('message').textContent = text;
    clearTimeout(say.timer);
    say.timer = setTimeout(() => { $('message').textContent = ''; }, 4000);
  }

  // ---- 左边的列表 ----

  /** 缩略图：不跑动画，每个形象画一帧 */
  function thumbnail(spec) {
    const canvas = document.createElement('canvas');
    const w = 116, h = 152;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    const compiled = window.SoulFigure.compile(spec);
    const out = [0, 0, 0, 0, false];
    const motion = { t: 1.7, eyeOpen: 1, mouth: 0, breath: .5 };
    const size = h * .92;
    for (let i = 0; i < compiled.particles.length; i++) {
      window.SoulFigure.place(compiled, i, motion, out);
      const [r, g, b] = compiled.colors[out[3]].rgb;
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, out[2])})`;
      ctx.beginPath();
      ctx.arc(w / 2 + out[0] * size, h / 2 + out[1] * size, .6, 0, 6.283);
      ctx.fill();
    }
    return canvas;
  }

  const sameChoice = (a, b) => a && b && a.kind === b.kind && a.id === b.id;

  function choiceButton(spec, choice) {
    const button = document.createElement('button');
    button.className = `choice${sameChoice(source, choice) ? ' on' : ''}`;
    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = spec.name;
    text.append(name);
    if (spec.note) {
      const note = document.createElement('small');
      note.textContent = spec.note;
      text.append(note);
    }
    if (sameChoice(active, choice)) {
      const using = document.createElement('div');
      using.className = 'using';
      using.textContent = '桌面正在用';
      text.append(using);
    }
    button.append(thumbnail(spec), text);
    button.addEventListener('click', () => loadFigure(spec, choice));
    return button;
  }

  function renderLists() {
    $('presets').textContent = '';
    for (const preset of window.SoulFigurePresets) $('presets').append(choiceButton(preset, { kind: 'preset', id: preset.id }));
    $('saved').textContent = '';
    for (const spec of saved) $('saved').append(choiceButton(spec, { kind: 'saved', id: spec.name }));
    $('savedEmpty').hidden = saved.length > 0;
    $('deleteBtn').hidden = source.kind !== 'saved';
  }

  function loadFigure(spec, choice) {
    figure = clone(spec);
    source = choice;
    selected = 0;
    history.length = 0;
    apply();
    renderLists();
    renderPanel();
  }

  // ---- 把改动送上舞台 ----

  function apply() {
    light.setFigure(figure);
    light.set('condense', previewState);
    drawHandles();
    const total = figure.layers.filter((layer) => !layer.hidden).reduce((sum, layer) => sum + (layer.count ?? 0), 0);
    $('count').textContent = `${total} / ${MAX} 个光点`;
    $('count').className = total > MAX ? 'over' : '';
  }

  /** 改之前记一笔，撤销用。连续拖动同一个滑块只记第一下 */
  function remember(tag) {
    if (tag && history.lastTag === tag && Date.now() - history.lastAt < 800) { history.lastAt = Date.now(); return; }
    history.push(JSON.stringify(figure));
    if (history.length > 100) history.shift();
    history.lastTag = tag;
    history.lastAt = Date.now();
  }

  // ---- 舞台上的控制点 ----

  function figureFrame() {
    const rect = handles.getBoundingClientRect();
    const size = rect.height * figure.height * SCALE;
    return { rect, size, cx: rect.width * CENTER.x, cy: rect.height * CENTER.y };
  }

  const toScreen = ([x, y], frame) => [frame.cx + x * frame.size, frame.cy + y * frame.size];
  const toFigure = (px, py, frame) => [+((px - frame.cx) / frame.size).toFixed(4), +((py - frame.cy) / frame.size).toFixed(4)];
  const round = (value) => Math.round(value * 1000) / 1000;

  function drawHandles() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const frame = figureFrame();
    handles.width = frame.rect.width * dpr;
    handles.height = frame.rect.height * dpr;
    const ctx = handles.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, frame.rect.width, frame.rect.height);
    const layer = figure.layers[selected];
    if (!layer?.points) return;
    if (layer.kind === 'curve' || layer.kind === 'stars') {
      ctx.strokeStyle = 'rgba(169,184,255,.28)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      layer.points.forEach((point, i) => {
        const [x, y] = toScreen(point, frame);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      if (layer.closed) ctx.closePath();
      if (layer.kind === 'curve') ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const point of layer.points) {
      const [x, y] = toScreen(point, frame);
      ctx.beginPath();
      ctx.arc(x, y, HANDLE_R, 0, 6.283);
      ctx.fillStyle = 'rgba(10,12,20,.75)';
      ctx.fill();
      ctx.strokeStyle = '#a9b8ff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function pointAt(event) {
    const layer = figure.layers[selected];
    if (!layer?.points) return -1;
    const frame = figureFrame();
    const px = event.clientX - frame.rect.left;
    const py = event.clientY - frame.rect.top;
    let best = -1;
    let bestD = (HANDLE_R + 6) ** 2;
    layer.points.forEach((point, i) => {
      const [x, y] = toScreen(point, frame);
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  let dragging = -1;
  handles.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = pointAt(event);
    if (dragging >= 0) {
      remember();
      handles.setPointerCapture(event.pointerId);
    }
  });
  handles.addEventListener('pointermove', (event) => {
    if (dragging >= 0) {
      const frame = figureFrame();
      figure.layers[selected].points[dragging] = toFigure(event.clientX - frame.rect.left, event.clientY - frame.rect.top, frame);
      apply();
    } else {
      handles.style.cursor = pointAt(event) >= 0 ? 'grab' : 'default';
    }
  });
  handles.addEventListener('pointerup', () => { dragging = -1; });
  // 双击加点：线条插在最近的一段中间，星点直接加
  handles.addEventListener('dblclick', (event) => {
    const layer = figure.layers[selected];
    if (!layer || (layer.kind !== 'curve' && layer.kind !== 'stars')) return;
    remember();
    const frame = figureFrame();
    const point = toFigure(event.clientX - frame.rect.left, event.clientY - frame.rect.top, frame);
    let at = layer.points.length;
    if (layer.kind === 'curve' && layer.points.length > 1) {
      let best = Infinity;
      for (let i = 0; i < layer.points.length - 1; i++) {
        const [a, b] = [layer.points[i], layer.points[i + 1]];
        const d = Math.hypot((a[0] + b[0]) / 2 - point[0], (a[1] + b[1]) / 2 - point[1]);
        if (d < best) { best = d; at = i + 1; }
      }
    }
    layer.points.splice(at, 0, point);
    apply();
  });
  handles.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const layer = figure.layers[selected];
    const index = pointAt(event);
    if (index < 0 || layer.points.length <= 1) return;
    remember();
    layer.points.splice(index, 1);
    apply();
  });
  new ResizeObserver(drawHandles).observe(handles);

  // ---- 右边的面板 ----

  const COLOR_DOT = (layer) => layer.color;

  function renderLayers() {
    $('layers').textContent = '';
    figure.layers.forEach((layer, i) => {
      const row = document.createElement('button');
      row.className = `layer${i === selected ? ' on' : ''}${layer.hidden ? ' off' : ''}`;
      const dot = document.createElement('i');
      dot.style.background = COLOR_DOT(layer);
      const name = document.createElement('span');
      name.textContent = layer.name;
      row.append(dot, name);
      row.addEventListener('click', () => {
        selected = i;
        renderPanel();
        drawHandles();
      });
      $('layers').append(row);
    });
  }

  const SLIDERS = {
    layerCount: { key: 'count', fallback: 100, show: (v) => String(v) },
    layerWidth: { key: 'width', fallback: .01, show: (v) => (+v).toFixed(3) },
    layerBrightness: { key: 'brightness', fallback: .8, show: (v) => (+v).toFixed(2) },
    layerTwinkle: { key: 'twinkle', fallback: .15, show: (v) => (+v).toFixed(2) },
    layerFlow: { key: 'flow', fallback: 0, show: (v) => (+v).toFixed(3) },
    layerSway: { key: 'sway', fallback: 0, show: (v) => (+v).toFixed(3) },
  };

  function renderPanel() {
    $('figureName').value = figure.name ?? '';
    $('figHeight').value = figure.height ?? .62;
    $('figHeightOut').textContent = (+$('figHeight').value).toFixed(2);
    $('figTint').value = figure.tint ?? .2;
    $('figTintOut').textContent = (+$('figTint').value).toFixed(2);
    renderLayers();
    const layer = figure.layers[selected];
    $('inspector').hidden = !layer;
    if (!layer) return;
    $('layerName').value = layer.name ?? '';
    $('layerColor').value = layer.color ?? '#a9c0ff';
    for (const [id, { key, fallback, show }] of Object.entries(SLIDERS)) {
      $(id).value = layer[key] ?? fallback;
      $(`${id}Out`).textContent = show($(id).value);
    }
    $('layerMirror').checked = Boolean(layer.mirror);
    $('layerClosed').checked = Boolean(layer.closed);
    $('layerGlow').checked = Boolean(layer.glow);
    $('layerMouth').checked = layer.role === 'mouth';
    const isCurve = layer.kind === 'curve';
    $('flowRow').hidden = !(isCurve || layer.kind === 'orb');
    $('swayRow').hidden = !isCurve;
    $('closedRow').hidden = !isCurve;
    $('mouthRow').hidden = !isCurve;
    $('layerHide').textContent = layer.hidden ? '显示' : '隐藏';
  }

  for (const [id, { key, show }] of Object.entries(SLIDERS)) {
    $(id).addEventListener('input', () => {
      remember(id);
      figure.layers[selected][key] = Number($(id).value);
      $(`${id}Out`).textContent = show($(id).value);
      apply();
    });
  }
  for (const [id, key] of [['layerMirror', 'mirror'], ['layerClosed', 'closed'], ['layerGlow', 'glow']]) {
    $(id).addEventListener('change', () => {
      remember();
      figure.layers[selected][key] = $(id).checked;
      apply();
    });
  }
  $('layerMouth').addEventListener('change', () => {
    remember();
    if ($('layerMouth').checked) figure.layers[selected].role = 'mouth';
    else delete figure.layers[selected].role;
    apply();
  });
  $('layerColor').addEventListener('input', () => {
    remember('color');
    figure.layers[selected].color = $('layerColor').value;
    apply();
    renderLayers();
  });
  $('layerName').addEventListener('change', () => {
    remember();
    figure.layers[selected].name = $('layerName').value.trim() || '图层';
    renderLayers();
  });
  $('figureName').addEventListener('change', () => { figure.name = $('figureName').value.trim() || '未命名'; });
  $('figHeight').addEventListener('input', () => {
    remember('height');
    figure.height = Number($('figHeight').value);
    $('figHeightOut').textContent = figure.height.toFixed(2);
    apply();
  });
  $('figTint').addEventListener('input', () => {
    remember('tint');
    figure.tint = Number($('figTint').value);
    $('figTintOut').textContent = figure.tint.toFixed(2);
    apply();
  });

  const NEW_LAYER = {
    curve: { name: '线条', color: '#a9c0ff', count: 240, width: .008, flow: .04, brightness: .8, twinkle: .25, points: [[-.15, -.1], [0, 0], [.15, .1]] },
    orb: { name: '光团', color: '#6f8fe8', count: 400, width: .15, flow: .05, brightness: .6, twinkle: .4, points: [[0, 0]] },
    eye: { name: '眼睛', color: '#ffffff', count: 180, width: .028, tall: 1.4, mirror: true, brightness: 1, twinkle: .1, glow: true, points: [[.09, -.1]] },
    stars: { name: '星点', color: '#dfe8ff', count: 160, width: .004, brightness: 1, twinkle: .55, glow: true, points: [[-.1, -.1], [.1, -.05], [0, .1]] },
  };

  document.querySelectorAll('.addLayer').forEach((button) => button.addEventListener('click', () => {
    remember();
    figure.layers.push({ kind: button.dataset.kind, ...clone(NEW_LAYER[button.dataset.kind]) });
    selected = figure.layers.length - 1;
    apply();
    renderPanel();
  }));
  $('layerUp').addEventListener('click', () => {
    if (selected === 0) return;
    remember();
    const [layer] = figure.layers.splice(selected, 1);
    selected -= 1;
    figure.layers.splice(selected, 0, layer);
    apply();
    renderPanel();
  });
  $('layerHide').addEventListener('click', () => {
    remember();
    figure.layers[selected].hidden = !figure.layers[selected].hidden;
    apply();
    renderPanel();
  });
  $('layerCopy').addEventListener('click', () => {
    remember();
    const copy = clone(figure.layers[selected]);
    copy.name = `${copy.name} 副本`;
    figure.layers.splice(selected + 1, 0, copy);
    selected += 1;
    apply();
    renderPanel();
  });
  $('layerRemove').addEventListener('click', () => {
    remember();
    figure.layers.splice(selected, 1);
    selected = Math.max(0, selected - 1);
    apply();
    renderPanel();
  });

  // ---- 预览状态 ----

  document.querySelectorAll('.state').forEach((button) => {
    button.classList.toggle('on', button.dataset.state === previewState);
    button.addEventListener('click', () => {
      previewState = button.dataset.state;
      document.querySelectorAll('.state').forEach((other) => other.classList.toggle('on', other === button));
      light.set('condense', previewState);
    });
  });

  // ---- 保存和使用 ----

  async function saveCurrent() {
    figure.name = $('figureName').value.trim() || '未命名';
    delete figure.id;
    delete figure.note;
    const stored = clone(figure);
    ({ saved, active } = await store.save(stored));
    source = { kind: 'saved', id: stored.name };
    renderLists();
    say(`已保存：${stored.name}`);
  }

  $('saveBtn').addEventListener('click', saveCurrent);
  $('deleteBtn').addEventListener('click', async () => {
    const name = source.id;
    ({ saved, active } = await store.remove(name));
    loadFigure(window.SoulFigurePresets[0], { kind: 'preset', id: window.SoulFigurePresets[0].id });
    say(`已删除：${name}`);
  });
  $('useBtn').addEventListener('click', async () => {
    // 内置方案没改过就直接用；改过了或是自己的设计，先存再用
    const preset = source.kind === 'preset' && window.SoulFigurePresets.find((item) => item.id === source.id);
    const untouched = preset && JSON.stringify(preset) === JSON.stringify(figure);
    if (!untouched) {
      if (preset) $('figureName').value = `${figure.name} 改`;
      await saveCurrent();
    }
    ({ saved, active } = await store.use(source));
    renderLists();
    say('已经用在桌面上了，它会亮出来给你看几秒');
  });
  if (!store.use) {
    $('useBtn').hidden = true;
    $('webNote').hidden = false;
  }

  // ---- 更多 ----

  function undo() {
    const last = history.pop();
    if (!last) return;
    figure = JSON.parse(last);
    selected = Math.min(selected, figure.layers.length - 1);
    apply();
    renderPanel();
  }

  $('undoBtn').addEventListener('click', undo);
  addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !/INPUT|TEXTAREA/.test(event.target.tagName)) {
      event.preventDefault();
      undo();
    }
  });

  // 描图参考只是垫在下面当底稿，不会进入形象
  const reference = $('reference');
  $('refBtn').addEventListener('click', () => $('refFile').click());
  $('refFile').addEventListener('change', () => {
    const file = $('refFile').files[0];
    if (!file) return;
    reference.src = URL.createObjectURL(file);
    reference.style.display = 'block';
    reference.style.opacity = $('refOpacity').value;
    reference.style.height = `${figureFrame().size}px`;
    $('refRow').hidden = false;
  });
  $('refOpacity').addEventListener('input', () => { reference.style.opacity = $('refOpacity').value; });

  const box = $('ioBox');
  $('exportBtn').addEventListener('click', async () => {
    box.hidden = false;
    box.value = JSON.stringify(figure, null, 1);
    box.select();
    try {
      await navigator.clipboard.writeText(box.value);
      say('已复制');
    } catch {
      say('可以从下面的框里复制');
    }
  });
  $('importBtn').addEventListener('click', () => {
    if (box.hidden) {
      box.hidden = false;
      box.value = '';
      box.placeholder = '把导出的内容贴到这里，再点一次导入';
      box.focus();
      return;
    }
    try {
      const spec = JSON.parse(box.value);
      if (!Array.isArray(spec.layers)) throw new Error('没有 layers');
      remember();
      loadFigure(spec, { kind: 'imported', id: spec.name });
      box.hidden = true;
      say('已导入');
    } catch (error) {
      say(`导入失败：${error.message}`);
    }
  });

  // ---- 开始 ----

  store.list().then((state) => {
    saved = state.saved;
    active = state.active;
    const start = active?.kind === 'saved'
      ? saved.find((item) => item.name === active.id)
      : window.SoulFigurePresets.find((item) => item.id === active?.id);
    if (start) loadFigure(start, active);
    else { apply(); renderLists(); renderPanel(); }
  });
  light.set('condense', previewState);
})();
