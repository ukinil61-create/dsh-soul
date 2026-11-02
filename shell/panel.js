// 桌面上的会话界面：列表、历史、发送、停止、审批。不用打开 App。

(() => {
  const host = window.soulHost;
  const $ = (id) => document.getElementById(id);
  const list = $('list'), logBox = $('log'), input = $('input'), search = $('search');
  const REFRESH_MS = 5000;

  let sessions = [];
  let current = null;
  let firstSeq = null;
  let hasMore = false;
  let liveAnswer = null;
  let liveText = '';
  const running = new Set();
  const toolRows = new Map();
  let searchHits = null;

  const homeless = (cwd) => cwd.split(/[\\/]/).filter(Boolean).pop() || cwd || '未分组';
  const titleOf = (s) => (s.main ? '主线' : s.title || '新会话');

  function renderList() {
    if (searchHits) {
      renderSearchHits();
      return;
    }
    const query = search.value.trim().toLowerCase();
    list.textContent = '';
    const shown = sessions.filter((s) => !s.blank || s.id === current);
    const main = shown.find((s) => s.main);
    const groups = new Map();
    for (const s of shown) {
      if (s.main) continue;
      if (query && !`${s.title} ${s.cwd}`.toLowerCase().includes(query)) continue;
      if (!groups.has(s.cwd)) groups.set(s.cwd, []);
      groups.get(s.cwd).push(s);
    }
    const row = (s) => {
      const button = document.createElement('button');
      button.className = `row${s.id === current ? ' on' : ''}${s.main ? ' main' : ''}`;
      const name = document.createElement('span');
      name.textContent = titleOf(s);
      button.append(name);
      if (running.has(s.id) || s.running) {
        const dot = document.createElement('i');
        dot.className = 'dot';
        button.append(dot);
      }
      if (!s.main) {
        // 行本身是按钮，里面不能再套按钮
        const archive = document.createElement('span');
        archive.className = 'rowArchive';
        archive.textContent = '归档';
        archive.title = '从列表里收起来，官方页面能找回';
        archive.setAttribute('role', 'button');
        archive.setAttribute('aria-label', `归档“${titleOf(s)}”`);
        archive.addEventListener('click', (event) => { event.stopPropagation(); archiveSession(s); });
        button.append(archive);
      }
      button.addEventListener('click', () => open(s.id));
      button.addEventListener('contextmenu', (event) => sessionMenu(s, event));
      return button;
    };
    if (main && !query) list.append(row(main));
    for (const [cwd, items] of groups) {
      const head = document.createElement('div');
      head.className = 'group';
      const name = document.createElement('span');
      name.textContent = homeless(cwd);
      name.title = cwd;
      // 鼠标移到工作区上才出现
      const add = document.createElement('button');
      add.className = 'groupAdd';
      add.textContent = '+';
      add.title = `在“${homeless(cwd)}”里新建会话`;
      add.setAttribute('aria-label', add.title);
      add.addEventListener('click', () => newSession(cwd));
      head.append(name, add);
      list.append(head, ...items.map(row));
    }
  }

  async function refresh() {
    try {
      ({ sessions } = await host.api('/sessions'));
      renderList();
      syncHead();
    } catch (error) {
      console.error(`sessions failed: ${error.message}`);
    }
  }

  function syncHead() {
    if (inSettings || inContext) return;
    const session = sessions.find((s) => s.id === current);
    $('title').textContent = session ? titleOf(session) : '';
    $('cwd').textContent = session?.cwd ?? '';
    $('stop').hidden = !(running.has(current) || session?.running);
  }

  // ---- 消息 ----

  const atBottom = () => logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 60;
  const follow = (wasAtBottom) => { if (wasAtBottom) logBox.scrollTop = logBox.scrollHeight; };

  /** 只处理代码块和行内代码、粗体，全部走 textContent，模型的输出不会变成网页 */
  function renderAnswer(box, text) {
    box.textContent = '';
    text.split(/(```[\s\S]*?(?:```|$))/g).forEach((part) => {
      if (!part) return;
      if (part.startsWith('```')) {
        const pre = document.createElement('pre');
        pre.textContent = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
        box.append(pre);
        return;
      }
      for (const para of part.split(/\n{2,}/)) {
        if (!para.trim()) continue;
        const p = document.createElement('p');
        para.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).forEach((piece) => {
          if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 1) {
            const code = document.createElement('code');
            code.textContent = piece.slice(1, -1);
            p.append(code);
          } else if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 3) {
            const strong = document.createElement('strong');
            strong.textContent = piece.slice(2, -2);
            p.append(strong);
          } else {
            p.append(piece);
          }
        });
        box.append(p);
      }
    });
  }

  function messageNode(message) {
    const box = document.createElement('div');
    if (message.kind === 'user') {
      box.className = 'msg user';
      box.textContent = message.text;
    } else if (message.kind === 'assistant') {
      box.className = 'msg assistant';
      renderAnswer(box, message.text);
    } else {
      box.className = 'tool';
      box.textContent = message.target ? `${message.name}  ${message.target}` : message.name;
      if (message.diff) {
        const diff = document.createElement('div');
        diff.className = 'diff';
        for (const [cls, text] of [['del', message.diff.before], ['add', message.diff.after]]) {
          if (!text) continue;
          const part = document.createElement('span');
          part.className = cls;
          part.textContent = text;
          diff.append(part);
        }
        box.append(diff);
      }
    }
    return box;
  }

  function moreButton() {
    const more = document.createElement('button');
    more.id = 'more';
    more.className = 'btn';
    more.textContent = '更早的消息';
    more.addEventListener('click', loadOlder);
    return more;
  }

  /** 等用户回答的卡片：会话 id -> 卡片 id -> 事件。切走再切回来还要在，不然那一轮就一直卡着 */
  const waitingCards = new Map();
  const cardsOf = (id) => {
    if (!waitingCards.has(id)) waitingCards.set(id, new Map());
    return waitingCards.get(id);
  };
  const cardNode = (event) => (event.type === 'approval' ? approvalCard(event) : questionCard(event));

  function showWaitingCards(id) {
    logBox.querySelectorAll('.approval, .question').forEach((node) => node.remove());
    for (const event of cardsOf(id).values()) logBox.append(cardNode(event));
  }

  async function open(id) {
    if (inSettings) showSettings(false);
    if (inContext) showContext(false);
    current = id;
    liveAnswer = null;
    liveText = '';
    slashItems = [];
    toolRows.clear();
    logBox.textContent = '';
    renderList();
    syncHead();
    if (!catalog) host.api('/model-catalog').then((res) => { catalog = res.catalog; syncModelChip(); }).catch(() => {});
    syncModelChip();
    try {
      const page = await host.api('/history', { sessionId: id });
      if (current !== id) return;
      firstSeq = page.firstSeq;
      hasMore = page.hasMore;
      if (page.running) running.add(id);
      if (hasMore) logBox.append(moreButton());
      logBox.append(...page.messages.map(messageNode));
      if (!page.messages.length) {
        const empty = document.createElement('div');
        empty.id = 'empty';
        empty.textContent = '还没有消息';
        logBox.append(empty);
      }
      showWaitingCards(id);
      logBox.scrollTop = logBox.scrollHeight;
      syncHead();
    } catch (error) {
      notice(`读取会话失败：${error.message}`);
    }
    input.focus();
  }

  async function loadOlder() {
    const id = current;
    const before = logBox.scrollHeight;
    const page = await host.api('/history', { sessionId: id, beforeSeq: firstSeq });
    if (current !== id) return;
    firstSeq = page.firstSeq;
    $('more')?.remove();
    logBox.prepend(...page.messages.map(messageNode));
    if (page.hasMore) logBox.prepend(moreButton());
    logBox.scrollTop = logBox.scrollHeight - before;
  }

  function notice(text) {
    const box = document.createElement('div');
    box.className = 'notice';
    box.textContent = text;
    logBox.append(box);
    logBox.scrollTop = logBox.scrollHeight;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || !current) return;
    input.value = '';
    autosize();
    const stick = true;
    $('empty')?.remove();
    logBox.append(messageNode({ kind: 'user', text }));
    follow(stick);
    closePop();
    // 命令由宿主执行，技能和普通话都是发给模型
    const first = text.split(/\s/)[0];
    if (first.startsWith('/')) {
      if (!slashItems.length) ({ items: slashItems } = await host.api('/completions', { sessionId: current, kind: 'slash' }).catch(() => ({ items: [] })));
      if (slashItems.some((item) => item.kind === 'command' && item.value === first)) {
        try {
          await host.api('/command', { sessionId: current, line: text });
        } catch (error) {
          notice(`命令没执行成功：${error.message}`);
        }
        return;
      }
    }
    running.add(current);
    syncHead();
    try {
      await host.api('/say', { sessionId: current, text });
    } catch (error) {
      notice(`没发出去：${error.message}`);
      running.delete(current);
      syncHead();
    }
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 2}px`;
  }

  // ---- 后台事件 ----

  function approvalCard(event) {
    const card = document.createElement('div');
    card.className = 'approval';
    card.dataset.approval = event.approvalId;
    card.textContent = event.reason || `要执行“${event.toolName}”`;
    const buttons = document.createElement('div');
    const choices = [['允许一次', 'allowed-once'], ...(event.canAlways ? [['一直允许', 'always']] : []), ['拒绝', 'rejected']];
    for (const [label, outcome] of choices) {
      const button = document.createElement('button');
      button.className = 'btn';
      button.textContent = label;
      button.addEventListener('click', () => {
        card.remove();
        cardsOf(event.sessionId).delete(event.approvalId);
        host.api('/approval', { approvalId: event.approvalId, outcome }).catch((error) => notice(`没能裁决：${error.message}`));
      });
      buttons.append(button);
    }
    card.append(buttons);
    return card;
  }

  /** 先记下要等用户的卡片：不在当前会话也不能丢 */
  function trackCards(event) {
    const cards = cardsOf(event.sessionId);
    if (event.type === 'approval') cards.set(event.approvalId, event);
    else if (event.type === 'approval-closed') cards.delete(event.approvalId);
    else if (event.type === 'question') cards.set(event.id, event);
    else if (event.type === 'question-closed') cards.delete(event.id);
    else if (event.type === 'end') cards.clear();
  }

  function onSessionEvent(event) {
    if (event.type === 'start') {
      running.add(event.sessionId);
      renderList();
    } else if (event.type === 'end') {
      running.delete(event.sessionId);
      renderList();
      refresh();
    }
    trackCards(event);
    if (event.sessionId !== current) {
      if (event.type === 'approval' || event.type === 'question') open(event.sessionId);
      return;
    }
    const stick = atBottom();
    switch (event.type) {
      case 'delta':
        if (!liveAnswer) {
          liveText = '';
          liveAnswer = messageNode({ kind: 'assistant', text: '' });
          logBox.append(liveAnswer);
        }
        liveText += event.text;
        renderAnswer(liveAnswer, liveText);
        break;
      case 'tool': {
        liveAnswer = null;
        const node = messageNode({ kind: 'tool', ...event });
        node.classList.add('running');
        logBox.querySelectorAll('.tool.running').forEach((row) => row.classList.remove('running'));
        toolRows.set(event.id, node);
        logBox.append(node);
        break;
      }
      case 'tool-result': {
        const node = toolRows.get(event.id);
        node?.classList.remove('running');
        if (event.ok === false) node?.classList.add('failed');
        break;
      }
      case 'approval':
        logBox.append(approvalCard(event));
        break;
      case 'question':
        logBox.append(questionCard(event));
        break;
      case 'question-closed':
        logBox.querySelector(`[data-question="${event.id}"]`)?.remove();
        break;
      case 'approval-closed':
        logBox.querySelector(`[data-approval="${event.approvalId}"]`)?.remove();
        break;
      case 'end':
        liveAnswer = null;
        logBox.querySelectorAll('.tool.running').forEach((row) => row.classList.remove('running'));
        break;
      default:
        return;
    }
    syncHead();
    follow(stick);
  }

  host.onEvent((event) => {
    if (event.kind === 'session') onSessionEvent(event.event);
    else if (event.kind === 'panel-open') {
      refresh().then(() => {
        const target = event.sessionId ?? current ?? sessions.find((s) => s.main)?.id;
        if (target && target !== current) open(target);
        else input.focus();
      });
    } else if (event.kind === 'official-esc') {
      if (inOfficial) goBack();
    }
  });

  // ---- 弹出层：平时看不见，用到才出现 ----

  const pop = $('pop');
  let popItems = [];
  let popIndex = 0;
  let popAccept = null;

  function closePop() {
    pop.hidden = true;
    pop.classList.remove('anchor-side');
    pop.style.top = '';
    pop.style.maxHeight = '';
    popItems = [];
    popAccept = null;
  }

  function showPop(items, accept) {
    pop.textContent = '';
    popItems = items;
    popIndex = 0;
    popAccept = accept;
    items.forEach((item, i) => {
      if (item.head) {
        const head = document.createElement('div');
        head.className = 'popHead';
        head.textContent = item.head;
        pop.append(head);
        return;
      }
      const button = document.createElement('button');
      button.className = `opt${item.chosen ? ' chosen' : ''}`;
      button.textContent = item.label;
      if (item.detail) {
        const small = document.createElement('small');
        small.textContent = item.detail;
        button.append(small);
      }
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        accept(item);
      });
      item.node = button;
      pop.append(button);
      if (popItems[popIndex]?.head) popIndex = i;
    });
    pop.hidden = !items.length;
    markPop();
  }

  function markPop() {
    popItems.forEach((item, i) => item.node?.classList.toggle('on', i === popIndex));
    popItems[popIndex]?.node?.scrollIntoView({ block: 'nearest' });
  }

  function movePop(step) {
    if (!popItems.length) return;
    do { popIndex = (popIndex + step + popItems.length) % popItems.length; } while (popItems[popIndex].head);
    markPop();
  }

  // ---- 输入框里的 / 和 @ ----

  let slashItems = [];
  let completionTimer;

  /** 光标前面正在打的 / 命令或 @ 文件。没有就返回 null */
  function tokenAtCaret() {
    const before = input.value.slice(0, input.selectionStart);
    const slash = /^\/([^\s]*)$/.exec(before);
    if (slash) return { kind: 'slash', query: slash[1], start: 0 };
    const at = /(?:^|\s)@([^\s]*)$/.exec(before);
    if (at) return { kind: 'file', query: at[1], start: before.length - at[1].length - 1 };
    return null;
  }

  function acceptCompletion(item, token) {
    const after = input.value.slice(input.selectionStart);
    const text = `${item.value} `;
    input.value = input.value.slice(0, token.start) + text + after;
    const caret = token.start + text.length;
    input.setSelectionRange(caret, caret);
    closePop();
    autosize();
    input.focus();
  }

  async function updateCompletions() {
    const token = tokenAtCaret();
    if (!token || !current) { if (popAccept?.completion) closePop(); return; }
    const accept = (item) => acceptCompletion(item, token);
    accept.completion = true;
    try {
      if (token.kind === 'slash') {
        if (!slashItems.length) ({ items: slashItems } = await host.api('/completions', { sessionId: current, kind: 'slash' }));
        const query = token.query.toLowerCase();
        showPop(slashItems.filter((item) => item.value.slice(1).toLowerCase().includes(query)).slice(0, 30).map((item) => ({ ...item })), accept);
      } else {
        const { items } = await host.api('/completions', { sessionId: current, kind: 'file', query: token.query });
        showPop(items.slice(0, 30), accept);
      }
    } catch (error) {
      console.error(`completion failed: ${error.message}`);
    }
  }

  // ---- 模型 ----

  let catalog = null;

  const selectionOf = (s) => s?.model?.lastUsed ?? s?.model?.current ?? s?.model?.selected ?? null;

  function modelName(provider, model) {
    for (const group of catalog?.groups ?? []) {
      if (group.id !== provider) continue;
      for (const item of group.models) if (item.id === model) return item;
    }
    return null;
  }

  function syncModelChip() {
    const session = sessions.find((s) => s.id === current);
    const picked = pickedModels.get(current) ?? selectionOf(session) ?? catalog?.default;
    const chip = $('modelChip');
    if (!picked) { chip.textContent = '模型'; return; }
    const item = modelName(picked.provider, picked.model);
    const effort = item?.reasoning?.efforts?.find((e) => e.id === picked.reasoningEffort)?.name ?? picked.reasoningEffort;
    chip.textContent = `${item?.name ?? picked.model}${effort ? ` · ${effort}` : ''}`;
  }

  const pickedModels = new Map();

  async function openModelMenu() {
    if (!pop.hidden) { closePop(); return; }
    if (!catalog) ({ catalog } = await host.api('/model-catalog'));
    const session = sessions.find((s) => s.id === current);
    const picked = pickedModels.get(current) ?? selectionOf(session) ?? catalog.default;
    const rows = [];
    for (const group of catalog.groups) {
      rows.push({ head: group.name });
      for (const item of group.models) {
        const chosen = picked?.provider === group.id && picked?.model === item.id;
        rows.push({ label: item.name, detail: item.description, chosen, provider: group.id, model: item.id, reasoningEffort: chosen ? picked.reasoningEffort : item.reasoning?.defaultEffort });
        if (chosen) for (const effort of item.reasoning?.efforts ?? []) {
          rows.push({ label: `　思考强度：${effort.name}`, chosen: effort.id === picked.reasoningEffort, provider: group.id, model: item.id, reasoningEffort: effort.id });
        }
      }
    }
    showPop(rows, async (row) => {
      closePop();
      try {
        await host.api('/select-model', { sessionId: current, provider: row.provider, model: row.model, reasoningEffort: row.reasoningEffort });
        pickedModels.set(current, { provider: row.provider, model: row.model, reasoningEffort: row.reasoningEffort });
        syncModelChip();
      } catch (error) {
        notice(`没能切换模型：${error.message}`);
      }
    });
    movePop(1);
  }

  // ---- 会话右键：重命名、分支 ----

  async function archiveSession(session) {
    try {
      await host.api('/archive', { sessionId: session.id });
      if (current === session.id) open(sessions.find((s) => s.main)?.id);
      refresh();
    } catch (error) {
      notice(`没能归档：${error.message}`);
    }
  }

  function sessionMenu(session, event) {
    event.preventDefault();
    const place = () => { pop.classList.add('anchor-side'); pop.style.top = `${Math.min(event.clientY, innerHeight - 120)}px`; };
    const rows = [{ label: '重命名', action: 'rename' }, { label: '从这里开一个分支', action: 'fork' }, { label: '看完整上下文', action: 'context' }];
    if (!session.main) rows.push({ label: '归档', detail: '从列表里收起来，官方页面能找回', action: 'archive' });
    showPop(rows, async (row) => {
      if (row.action === 'context') {
        closePop();
        await open(session.id);
        showContext(true);
        return;
      }
      if (row.action === 'archive') {
        closePop();
        archiveSession(session);
        return;
      }
      if (row.action === 'rename') {
        pop.textContent = '';
        const field = document.createElement('input');
        field.value = session.title;
        field.setAttribute('aria-label', '新名字');
        field.addEventListener('keydown', async (key) => {
          if (key.key === 'Escape') { key.stopPropagation(); closePop(); }
          if (key.key !== 'Enter' || key.isComposing || !field.value.trim()) return;
          closePop();
          await host.api('/rename', { sessionId: session.id, title: field.value.trim() }).catch((error) => notice(`没能重命名：${error.message}`));
          refresh();
        });
        pop.append(field);
        field.focus();
        field.select();
        return;
      }
      closePop();
      try {
        const { sessionId } = await host.api('/fork', { sessionId: session.id });
        await refresh();
        if (sessionId) open(sessionId);
      } catch (error) {
        notice(`没能开分支：${error.message}`);
      }
    });
    place();
  }

  // ---- 拖头部移动，拖四边改大小。默认样子不变，改过的位置会记住，双击头部回到默认 ----

  function grab(node, edge) {
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      node.setPointerCapture(event.pointerId);
      host.panelDrag(edge);
    });
    const release = (event) => {
      if (!node.hasPointerCapture(event.pointerId)) return;
      node.releasePointerCapture(event.pointerId);
      host.panelDrag(null);
    };
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
  }

  grab($('head'), 'move');
  for (const edge of ['left', 'right', 'top', 'bottom']) grab($(`grab-${edge}`), edge);
  $('head').addEventListener('dblclick', (event) => {
    if (!event.target.closest('button')) host.panelDrag('reset');
  });

  // ---- 它问你的问题 ----

  function questionCard(event) {
    const card = document.createElement('div');
    card.className = 'question';
    card.dataset.question = event.id;
    const answers = new Map();
    for (const question of event.questions) {
      const state = { selected: new Set(), custom: '' };
      answers.set(question.id, state);
      const title = document.createElement('div');
      title.textContent = question.question;
      card.append(title);
      const choices = document.createElement('div');
      choices.className = 'choices';
      for (const option of question.options ?? []) {
        const button = document.createElement('button');
        button.className = 'btn choice';
        button.textContent = option.label;
        if (option.description) button.title = option.description;
        button.addEventListener('click', () => {
          if (question.multi_select ?? question.multiSelect) {
            if (state.selected.has(option.label)) state.selected.delete(option.label);
            else state.selected.add(option.label);
          } else {
            state.selected = new Set([option.label]);
          }
          choices.querySelectorAll('.choice').forEach((node) => node.classList.toggle('picked', state.selected.has(node.textContent)));
        });
        choices.append(button);
      }
      card.append(choices);
      const other = document.createElement('input');
      other.placeholder = '或者直接写';
      other.setAttribute('aria-label', '自己写的答案');
      other.addEventListener('input', () => { state.custom = other.value; });
      card.append(other);
    }
    const submit = document.createElement('button');
    submit.className = 'btn submit';
    submit.textContent = '回答';
    submit.addEventListener('click', async () => {
      const payload = [...answers].map(([id, state]) => ({ id, selected: [...state.selected], ...(state.custom.trim() ? { custom: state.custom.trim() } : {}) }));
      submit.disabled = true;
      try {
        await host.api('/question', { questionId: event.id, answer: { answers: payload } });
        cardsOf(event.sessionId).delete(event.id);
        card.remove();
      } catch (error) {
        submit.disabled = false;
        notice(`没能回答：${error.message}`);
      }
    });
    card.append(submit);
    return card;
  }

  // ---- 设置页：换下会话，不离开这个界面 ----

  const settingsBox = $('settings');
  let inSettings = false;
  let inOfficial = false;
  let inContext = false;
  const contextView = window.createContextView({ box: $('context'), api: host.api });

  /** 一层一层退：官方页面退回设置，设置和完整上下文退回会话 */
  function goBack() {
    if (inContext) {
      showContext(false);
    } else if (inOfficial) {
      inOfficial = false;
      $('app').classList.remove('official');
      host.closeOfficial();
      $('title').textContent = '设置和更多';
    } else {
      showSettings(false);
    }
  }

  function showContext(on) {
    inContext = on;
    $('context').hidden = !on;
    logBox.hidden = on;
    $('composer').hidden = on;
    $('meta').hidden = on;
    $('back').hidden = !on;
    if (on) {
      const session = sessions.find((s) => s.id === current);
      $('title').textContent = `完整上下文 · ${session ? titleOf(session) : ''}`;
      contextView.show(current);
    } else {
      contextView.stop();
      syncHead();
    }
  }

  function showSettings(on) {
    if (on && inContext) showContext(false);
    inSettings = on;
    settingsBox.hidden = !on;
    logBox.hidden = on;
    $('composer').hidden = on;
    $('meta').hidden = on;
    $('back').hidden = !on;
    if (on) {
      $('title').textContent = '设置和更多';
      $('cwd').textContent = '';
      renderSettings();
    } else {
      host.closeOfficial();
      syncHead();
    }
  }

  const section = (title) => {
    const box = document.createElement('div');
    box.className = 'section';
    const head = document.createElement('h3');
    head.textContent = title;
    box.append(head);
    settingsBox.append(box);
    return box;
  };

  const field = (box, label, control, hint) => {
    const row = document.createElement('label');
    row.className = 'field';
    const name = document.createElement('span');
    name.textContent = label;
    row.append(name, control);
    if (hint) {
      const note = document.createElement('span');
      note.className = 'hint';
      note.textContent = hint;
      row.append(note);
    }
    box.append(row);
    return row;
  };

  const select = (options, value, change) => {
    const node = document.createElement('select');
    for (const [id, text] of options) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = text;
      node.append(option);
    }
    node.value = value;
    node.addEventListener('change', () => change(node.value));
    return node;
  };

  const text = (value, change, placeholder = '') => {
    const node = document.createElement('input');
    node.value = value ?? '';
    node.placeholder = placeholder;
    node.spellcheck = false;
    node.addEventListener('change', () => change(node.value.trim()));
    return node;
  };

  /** 按下组合键就记录，比让人手写 Control+Alt+Q 靠谱 */
  const hotkeyInput = (value, which, box) => {
    const node = document.createElement('input');
    node.value = value;
    node.readOnly = true;
    node.placeholder = '点这里，然后按组合键';
    let row;
    node.addEventListener('keydown', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
      const parts = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
      if (!parts.length) return;
      const key = event.code.startsWith('Key') ? event.code.slice(3) : event.code.startsWith('Digit') ? event.code.slice(5) : event.key.length === 1 ? event.key.toUpperCase() : event.key;
      const accelerator = [...parts, key].join('+');
      const { error, settings } = await host.setSetting('hotkey', { which, accelerator });
      node.value = settings.hotkeys[which];
      row.querySelector('.error')?.remove();
      if (error) {
        const note = document.createElement('span');
        note.className = 'error';
        note.textContent = error;
        row.append(note);
      }
    });
    row = field(box, { panel: '打开会话', summon: '在窗口上说话', voice: '直接用语音说' }[which], node);
    return row;
  };

  async function renderSettings() {
    settingsBox.textContent = '';
    const settings = await host.getSettings();

    const look = section('它的样子');
    field(look, '平时的样子', select([['condense', '光凝成形象'], ['formless', '平时无形']], settings.form, (v) => host.setSetting('form', v)));
    field(look, '对话时', select([['present', '一直是形象，光环表示在听'], ['sayOnly', '开口才聚成形象']], settings.looks, (v) => host.setSetting('looks', v)));
    field(look, '干活时', select([['expand', '做得久才展开工作区'], ['quiet', '只看到它在忙']], settings.work, (v) => host.setSetting('work', v)));

    const figureButton = document.createElement('button');
    figureButton.className = 'btn link';
    figureButton.textContent = '打开光点形象工作室';
    figureButton.addEventListener('click', () => host.openStudio());
    look.append(figureButton);

    const voice = section('语音');
    field(voice, '语音合成服务', select([['volc', '火山引擎'], ['minimax', 'MiniMax（本机工具）']], settings.voice.provider, async (v) => {
      await host.setSetting('voice', { provider: v });
      renderSettings();
    }));
    if (settings.voice.provider === 'minimax') {
      const mm = settings.voice.minimax;
      field(voice, '模型', select([['speech-2.8-turbo', 'speech-2.8-turbo（更快、更便宜）'], ['speech-2.8-hd', 'speech-2.8-hd（音质优先）']], mm.model, (v) => host.setSetting('voice', { minimax: { model: v } })), '每句都按字符扣 MiniMax 余额');
      const voiceInput = text(mm.voice, (v) => host.setSetting('voice', { minimax: { voice: v } }));
      voiceInput.setAttribute('list', 'mmVoices');
      const voices = document.createElement('datalist');
      voices.id = 'mmVoices';
      for (const item of await host.minimaxVoices()) {
        const option = document.createElement('option');
        option.value = item.id;
        option.label = item.name;
        voices.append(option);
      }
      voice.append(voices);
      field(voice, '音色 ID', voiceInput);
      field(voice, '语速', text(String(mm.speed ?? 1), (v) => host.setSetting('voice', { minimax: { speed: Number(v) || 1 } }), '1 是正常语速'));
      field(voice, '工具目录', text(mm.toolDir, (v) => host.setSetting('voice', { minimax: { toolDir: v } })), '密钥由这个工具自己解密，这里不经手');
    } else {
      field(voice, '模型', text(settings.voice.model, (v) => host.setSetting('voice', { model: v }), 'seed-tts-2.0'));
      field(voice, '音色 ID', text(settings.voice.speaker, (v) => host.setSetting('voice', { speaker: v }), '留空用默认音色'));
      field(voice, '语速', text(String(settings.voice.rate ?? 0), (v) => host.setSetting('voice', { rate: Number(v) || 0 }), '0 是正常语速'));
      field(voice, '密钥文件', text(settings.voice.keyFile, (v) => host.setSetting('voice', { keyFile: v }), '留空沿用现有密钥'), '文件里要有 volc_appid 和 volc_token');
    }
    const speak = document.createElement('input');
    speak.type = 'checkbox';
    speak.checked = settings.speak;
    speak.addEventListener('change', () => host.setSetting('speak', speak.checked));
    field(voice, '念出回答', speak);
    const wake = document.createElement('input');
    wake.type = 'checkbox';
    wake.checked = settings.wake;
    wake.addEventListener('change', () => host.setSetting('wake', wake.checked));
    field(voice, '语音唤醒', wake, '语音识别是本地的 SenseVoice，模型在下面的官方页面里管理');
    const test = document.createElement('button');
    test.className = 'btn link';
    test.textContent = '试听';
    test.addEventListener('click', () => host.voiceTest());
    voice.append(test);

    const keys = section('快捷键');
    for (const which of ['panel', 'summon', 'voice']) hotkeyInput(settings.hotkeys[which], which, keys);

    const allowed = section('它能做什么');
    const state = await host.api('/permissions');
    for (const [category, label] of Object.entries(state.categories)) {
      field(allowed, label, select([['ask', '危险的才问我'], ['allow', '一直允许'], ['deny', '不允许']], state.levels[category] ?? 'ask', (level) => host.api('/permissions', { category, level })));
    }

    const own = section('它自己的时间');
    const life = await host.api('/autonomy');
    field(own, '自主程度', select(Object.entries(life.levels).map(([id, level]) => [id, level.label]), life.level, (level) => host.api('/autonomy', { level })), '你离开电脑时它能做到哪一步，超出的操作会被拦下');
    field(own, '每天预算（元）', text(String(life.budgetYuan), (v) => host.api('/autonomy', { budgetYuan: Number(v) })), '只算它自己活动的费用，花完就睡到明天，你找它不受影响。填 0 就不自己活动');
    if (!catalog) ({ catalog } = await host.api('/model-catalog'));
    const models = catalog.groups.flatMap((group) => group.models.map((item) => [`${group.id}|${item.id}`, item.name]));
    field(own, '它自己用的模型', select(models, `${life.model.provider}|${life.model.model}`, (value) => {
      const [provider, model] = value.split('|');
      host.api('/autonomy', { model: { provider, model } });
    }), '不开思考。模型越贵，同样的预算能做的越少');
    const plain = (words) => {
      const node = document.createElement('span');
      node.textContent = words;
      return node;
    };
    const spent = `花了约 ¥${life.spent.toFixed(3)}，调用模型 ${life.calls} 次`;
    field(own, '今天', plain(life.asleep ? `${spent}。预算花完了，它睡了，明天醒` : life.running ? `${spent}。它正在自己活动` : spent));
    for (const word of life.words) field(own, `${new Date(word.at).toLocaleString('sv').slice(5, 16)} 留的话`, plain(word.text));
    const ownButtons = document.createElement('div');
    ownButtons.className = 'row-buttons';
    if (life.soloId) {
      const today = document.createElement('button');
      today.className = 'btn link';
      today.textContent = '看它今天做了什么';
      today.addEventListener('click', () => open(life.soloId));
      ownButtons.append(today);
    }
    const soloNow = document.createElement('button');
    soloNow.className = 'btn link';
    soloNow.textContent = '现在让它自己待一会儿';
    soloNow.addEventListener('click', async () => {
      const { started } = await host.api('/solo-now');
      soloNow.textContent = started ? '它开始了' : '现在不行：它已经在活动，或者今天的预算花完了';
      soloNow.disabled = true;
    });
    ownButtons.append(soloNow);
    own.append(ownButtons);

    const more = section('更多');
    const buttons = document.createElement('div');
    buttons.className = 'row-buttons';
    const official = document.createElement('button');
    official.className = 'btn link';
    official.textContent = '插件、自动化任务和全部官方功能';
    official.addEventListener('click', async () => {
      inOfficial = true;
      $('app').classList.add('official');
      $('title').textContent = '官方页面';
      try {
        await host.openOfficial();
      } catch (error) {
        inOfficial = false;
        $('app').classList.remove('official');
        console.error(`official failed: ${error.message}`);
      }
    });
    const records = document.createElement('button');
    records.className = 'btn link';
    records.textContent = '它的记录（身份、记忆、变化历史）';
    records.addEventListener('click', () => host.openRecords());
    // 要点两次：第一次只是说清楚会发生什么
    const reborn = document.createElement('button');
    reborn.className = 'btn link';
    reborn.textContent = '让它重新诞生';
    reborn.addEventListener('click', async () => {
      if (!reborn.dataset.sure) {
        reborn.dataset.sure = '1';
        reborn.textContent = '再点一次确认：身份、记忆、名字、日记、授权和主线都清空重来（会先备份）';
        return;
      }
      reborn.disabled = true;
      reborn.textContent = '正在重新开始…';
      try {
        await host.api('/rebirth');
        showSettings(false);
        current = null;
        await refresh();
        const main = sessions.find((s) => s.main);
        if (main) open(main.id);
      } catch (error) {
        reborn.disabled = false;
        reborn.textContent = `没成功：${error.message}`;
      }
    });
    buttons.append(official, records, reborn);
    more.append(buttons);
  }

  async function newSession(cwd) {
    try {
      const { sessionId } = await host.api('/new', { cwd });
      await refresh();
      open(sessionId);
    } catch (error) {
      notice(`没能新建：${error.message}`);
    }
  }

  // ---- 按内容搜索：搜索框回车才搜，平时只按标题过滤 ----

  const listNote = (text) => {
    list.textContent = '';
    const note = document.createElement('div');
    note.className = 'group';
    note.textContent = text;
    list.append(note);
  };

  /** 搜到的结果一直留着，不被定时刷新冲掉，改了搜索框才回到普通列表 */
  function renderSearchHits() {
    if (!searchHits.length) {
      listNote('没有找到');
      return;
    }
    list.textContent = '';
    for (const item of searchHits) {
      const button = document.createElement('button');
      button.className = `row${item.id === current ? ' on' : ''}`;
      const name = document.createElement('span');
      name.textContent = item.title || sessions.find((s) => s.id === item.id)?.title || '会话';
      if (item.snippet) button.title = item.snippet;
      button.append(name);
      button.addEventListener('click', () => open(item.id));
      list.append(button);
    }
  }

  async function searchContent() {
    const query = search.value.trim();
    if (!query) return;
    listNote('正在翻会话记录…');
    try {
      const { items } = await host.api('/search', { query });
      if (search.value.trim() !== query) return;
      searchHits = items;
      renderSearchHits();
    } catch (error) {
      listNote('没搜成');
      console.error(`search failed: ${error.message}`);
    }
  }

  // ---- 操作 ----

  input.addEventListener('input', () => {
    autosize();
    clearTimeout(completionTimer);
    completionTimer = setTimeout(updateCompletions, 120);
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (popAccept?.completion && popItems.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); movePop(1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); movePop(-1); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); popAccept(popItems[popIndex]); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  // 粘贴图片存成文件，把路径放进输入框
  input.addEventListener('paste', async (event) => {
    const image = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault();
    const file = await host.pasteImage(new Uint8Array(await image.getAsFile().arrayBuffer()));
    input.value += (input.value && !input.value.endsWith('\n') ? '\n' : '') + file;
    autosize();
  });
  // Esc 一层一层退：弹出层、官方页面和设置、最后才收起
  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    if (!pop.hidden) closePop();
    else if (inSettings || inContext) goBack();
    else host.closePanel();
  });
  $('back').addEventListener('click', goBack);
  addEventListener('mousedown', (event) => { if (!pop.hidden && !pop.contains(event.target)) closePop(); });
  search.addEventListener('input', () => {
    searchHits = null;
    renderList();
  });
  search.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) searchContent(); });
  $('modelChip').addEventListener('mousedown', (event) => event.stopPropagation());
  $('modelChip').addEventListener('click', openModelMenu);
  $('settingsBtn').addEventListener('click', () => showSettings(!inSettings));
  $('contextBtn').addEventListener('click', () => showContext(true));
  $('send').addEventListener('click', send);
  $('close').addEventListener('click', () => host.closePanel());
  $('stop').addEventListener('click', () => host.api('/cancel', { sessionId: current }).catch((error) => notice(`没能停止：${error.message}`)));
  // 新建是在某个工作区里开一个会话；选文件夹只是其中一个选项
  $('newBtn').addEventListener('mousedown', (event) => event.stopPropagation());
  $('newBtn').addEventListener('click', () => {
    if (!pop.hidden) { closePop(); return; }
    const seen = new Set();
    const rows = [{ head: '在哪个工作区新建会话' }];
    const currentCwd = sessions.find((s) => s.id === current)?.cwd;
    for (const cwd of [currentCwd, ...sessions.filter((s) => !s.main).map((s) => s.cwd)]) {
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      rows.push({ label: homeless(cwd), detail: cwd, cwd });
    }
    rows.push({ head: '不在上面' }, { label: '选择其他文件夹…', pick: true });
    showPop(rows, async (row) => {
      closePop();
      const cwd = row.pick ? await host.pickFolder() : row.cwd;
      if (cwd) newSession(cwd);
    });
    pop.classList.add('anchor-side');
    pop.style.top = '62px';
    pop.style.maxHeight = `${innerHeight - 90}px`;
    movePop(1);
  });
  // 拖进来的文件把路径填进输入框
  addEventListener('dragover', (event) => event.preventDefault());
  addEventListener('drop', (event) => {
    event.preventDefault();
    const paths = [...event.dataTransfer.files].map((file) => host.pathFor(file));
    if (!paths.length) return;
    input.value += (input.value && !input.value.endsWith('\n') ? '\n' : '') + paths.join('\n');
    autosize();
    input.focus();
  });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, REFRESH_MS);
  host.ready();
})();
