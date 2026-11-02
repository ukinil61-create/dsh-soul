// 一个会话的完整上下文：模型实际拿到的系统提示、工具、每条消息、每次工具的参数和结果，还有用量。
// 被压缩替换掉的内容也留着，但标出来：记录还在，模型现在看不到。
// 只读，全部走 textContent。内容可能很长，详情点开才画。

(() => {
  const PREVIEW_CHARS = 120;

  const textOf = (content) => (Array.isArray(content)
    ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('')
    : String(content ?? ''));

  const pretty = (value) => {
    if (typeof value !== 'string') return JSON.stringify(value, null, 2);
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  };

  const tokens = (value) => (Number(value) || 0).toLocaleString('en-US');

  /** 一条记录变成一行或几行：标签、标题、全文 */
  function rowsOf(event) {
    const data = event.data ?? {};
    const base = { seq: event.seq, type: event.type };
    switch (event.type) {
      case 'system/message':
        return [{ ...base, tag: '系统提示', kind: 'system', body: textOf(data.message?.content) }];
      case 'developer/message': {
        // 这种消息的内容块不一定是文字，读不出文字就原样给
        const content = data.message?.content ?? data.content;
        return [{ ...base, tag: '开发者消息', kind: 'system', body: textOf(content) || pretty(content) }];
      }
      case 'user/message': {
        const source = data.source?.kind ?? 'user';
        return [{ ...base, tag: source === 'user' ? '用户' : `注入（${source}）`, kind: source === 'user' ? 'user' : 'system', body: textOf(data.content) }];
      }
      case 'assistant/message': {
        const parts = data.message?.content ?? [];
        const rows = [];
        const thinking = parts.filter((part) => part?.type === 'reasoning' || part?.type === 'thinking').map((part) => part.text ?? part.reasoning ?? '').join('');
        if (thinking) rows.push({ ...base, tag: '思考', kind: 'thinking', body: thinking });
        const answer = textOf(parts);
        if (answer) rows.push({ ...base, tag: '回答', kind: 'assistant', body: answer });
        const usage = data.usage;
        if (usage) rows.push({ ...base, tag: '用量', kind: 'usage', inline: `新输入 ${tokens(usage.inputTokens)} · 缓存 ${tokens(usage.cacheReadTokens)} · 输出 ${tokens(usage.outputTokens)}` });
        return rows;
      }
      case 'tool/call':
        return [{ ...base, tag: `调用 ${data.name}`, kind: 'tool', body: pretty(data.arguments) }];
      case 'tool/result':
        return [{ ...base, tag: data.message?.isError ? '工具结果（失败）' : '工具结果', kind: data.message?.isError ? 'failed' : 'tool', body: textOf(data.message?.content) }];
      case 'request/header': {
        const header = data.header ?? {};
        const names = (header.tools ?? []).map((tool) => tool.name).join('、');
        return [
          { ...base, tag: '模型参数', kind: 'system', body: pretty(header.config ?? {}) },
          { ...base, tag: `可用工具 ${(header.tools ?? []).length} 个`, kind: 'system', preview: names, body: pretty(header.tools ?? []) },
        ];
      }
      case 'compaction/summary':
        return [{ ...base, tag: '压缩摘要', kind: 'compact', preview: `替换了约 ${tokens(data.shadowedTokenCount)} token 的旧内容`, body: textOf(data.summary) }];
      case 'compaction/prune':
        return [{ ...base, tag: '裁剪', kind: 'compact', inline: `去掉了 ${(data.shadowedSeqs ?? []).length} 条旧内容，约 ${tokens(data.shadowedTokenCount)} token` }];
      default:
        // 流程记录：不是上下文内容，勾选才显示
        return [{ ...base, tag: event.type, kind: 'internal', body: pretty(data) }];
    }
  }

  /** 哪些记录已经被压缩或裁剪替换掉了 */
  function goneSeqs(events) {
    const gone = new Set();
    for (const event of events) {
      if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
        for (const seq of event.data?.shadowedSeqs ?? []) gone.add(seq);
      }
    }
    return gone;
  }

  function summaryLines(values) {
    const lines = [];
    const model = values.modelSelection?.lastUsed ?? values.modelSelection?.next;
    if (model) lines.push(['模型', `${model.model}${model.reasoningEffort ? ` · 思考 ${model.reasoningEffort}` : ''}`]);
    if (values.workingDirectory) lines.push(['工作目录', values.workingDirectory]);
    const pressure = values.contextPressure;
    if (pressure?.contextWindow) lines.push(['现在占用', `${tokens(pressure.pressureTokens)} / ${tokens(pressure.contextWindow)}（${((pressure.pressureTokens / pressure.contextWindow) * 100).toFixed(1)}%）`]);
    const parts = values.contextBreakdown;
    if (parts) lines.push(['其中', `系统提示 ${tokens(parts.systemTokens)} · 工具定义 ${tokens(parts.toolsTokens)} · 消息 ${tokens(parts.messageTokens)}`]);
    const used = values.tokenUsage;
    if (used) lines.push(['累计用量', `新输入 ${tokens(used.uncachedInputTokens)} · 缓存 ${tokens(used.cacheReadTokens)} · 输出 ${tokens(used.outputTokens)}`]);
    const stats = values.sessionStats;
    if (stats) lines.push(['轮次', `${stats.turns ?? 0} 轮 · ${stats.steps ?? 0} 步`]);
    if (values.permissions?.currentValue) lines.push(['官方权限', values.permissions.currentValue]);
    return lines;
  }

  function preview(row) {
    if (row.inline) return row.inline;
    return (row.preview ?? row.body ?? '').replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS);
  }

  function rowNode(row) {
    if (row.inline) {
      const line = document.createElement('div');
      line.className = `ctx-row ctx-${row.kind} ctx-inline`;
      const tag = document.createElement('b');
      tag.textContent = row.tag;
      line.append(tag, row.inline);
      return line;
    }
    const box = document.createElement('details');
    box.className = `ctx-row ctx-${row.kind}${row.gone ? ' ctx-gone' : ''}`;
    const head = document.createElement('summary');
    const tag = document.createElement('b');
    tag.textContent = row.tag;
    const brief = document.createElement('span');
    brief.textContent = preview(row);
    const size = document.createElement('i');
    size.textContent = `${(row.body ?? '').length} 字`;
    head.append(tag, brief, size);
    box.append(head);
    box.addEventListener('toggle', () => {
      if (!box.open || box.querySelector('pre')) return;
      const pre = document.createElement('pre');
      pre.textContent = row.body ?? '';
      box.append(pre);
    });
    return box;
  }

  /** box 是显示的地方，api 是 host.api */
  window.createContextView = ({ box, api }) => {
    let events = [];
    let rows = [];
    let values = {};
    let showInternal = false;
    let filter = '';
    let serial = 0;
    let listNode = null;

    function drawList() {
      if (!listNode) return;
      listNode.textContent = '';
      const needle = filter.trim().toLowerCase();
      const shown = rows.filter((row) => (showInternal || row.kind !== 'internal')
        && (!needle || `${row.tag}\n${row.body ?? row.inline ?? ''}`.toLowerCase().includes(needle)));
      listNode.append(...shown.map(rowNode));
      if (!shown.length) listNode.textContent = '没有符合的内容';
    }

    function drawAll(loading) {
      box.textContent = '';
      const summary = document.createElement('div');
      summary.className = 'ctx-summary';
      for (const [name, value] of summaryLines(values)) {
        const label = document.createElement('span');
        label.textContent = name;
        const text = document.createElement('span');
        text.textContent = value;
        summary.append(label, text);
      }
      const tools = document.createElement('div');
      tools.className = 'ctx-tools';
      const search = document.createElement('input');
      search.placeholder = '在这个会话的上下文里找';
      search.spellcheck = false;
      search.value = filter;
      search.setAttribute('aria-label', '在上下文里找');
      search.addEventListener('input', () => { filter = search.value; drawList(); });
      const openAll = document.createElement('button');
      openAll.className = 'btn';
      openAll.textContent = '全部展开';
      openAll.addEventListener('click', () => {
        const opening = openAll.textContent === '全部展开';
        listNode.querySelectorAll('details').forEach((node) => { node.open = opening; });
        openAll.textContent = opening ? '全部收起' : '全部展开';
      });
      const internal = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = showInternal;
      check.addEventListener('change', () => { showInternal = check.checked; drawList(); });
      internal.append(check, '也显示流程记录');
      const note = document.createElement('span');
      note.className = 'ctx-note';
      const goneCount = rows.filter((row) => row.gone).length;
      note.textContent = loading ? '正在读取…' : `共 ${rows.filter((row) => row.kind !== 'internal').length} 条${goneCount ? `，${goneCount} 条已压缩` : ''}`;
      tools.append(search, openAll, internal, note);
      listNode = document.createElement('div');
      listNode.className = 'ctx-list';
      box.append(summary, tools, listNode);
      drawList();
    }

    return {
      /** 从新往旧一页页读，读到头为止。切走了就停 */
      async show(sessionId) {
        const mine = ++serial;
        events = [];
        rows = [];
        values = {};
        filter = '';
        drawAll(true);
        let beforeSeq;
        const rebuild = () => {
          const gone = goneSeqs(events);
          rows = events.flatMap((event) => rowsOf(event).map((row) => ({ ...row, gone: gone.has(event.seq) })));
        };
        try {
          for (;;) {
            const page = await api('/context', { sessionId, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
            if (mine !== serial) return;
            values = page.values;
            events = [...page.records, ...events];
            rebuild();
            if (!page.hasMore || !page.records.length) break;
            // 长会话有几十页：先画最新的一页，后面只报进度，读完再一起画
            if (beforeSeq === undefined) drawAll(true);
            else box.querySelector('.ctx-note').textContent = `正在读取… ${rows.length} 条`;
            beforeSeq = page.records[0].seq;
          }
          drawAll(false);
        } catch (error) {
          if (mine !== serial) return;
          box.textContent = `读不了这个会话：${error.message}`;
        }
      },
      stop() {
        serial += 1;
        box.textContent = '';
      },
    };
  };
})();
