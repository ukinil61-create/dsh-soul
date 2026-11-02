// 字幕：把回答切成一条条短句。桌面页面和念出来的那边共用同一套切法，也能在 Node 里单独测。

(() => {
  /** 一条字幕最多这么多字。46vw、25px 的字宽下约 35 字一行，留点余量就是一行 */
  const MAX_CHARS = 30;
  /** 没有声音时每个字显示多久 */
  const MS_PER_CHAR = 220;
  const MIN_LINE_MS = 1200;

  /** 去掉念不出来也不该显示的东西：Markdown 记号和链接 */
  const clean = (text) => text.replace(/[`*#_>|~]/g, '').replace(/https?:\/\/\S+/g, '').trim();

  /** 一边收回答一边切句，代码块整段跳过。push 返回新凑齐的句子，flush 返回剩下的 */
  function createSentenceStream() {
    let buffer = '';
    let inCode = false;
    return {
      push(delta) {
        buffer += delta;
        const done = [];
        for (;;) {
          const fence = buffer.indexOf('```');
          const end = buffer.search(/[。！？!?\n]/);
          if (fence !== -1 && (end === -1 || fence < end)) {
            if (!inCode) done.push(buffer.slice(0, fence));
            inCode = !inCode;
            buffer = buffer.slice(fence + 3);
            continue;
          }
          if (end === -1) break;
          if (!inCode) done.push(buffer.slice(0, end + 1));
          buffer = buffer.slice(end + 1);
        }
        return done.map(clean).filter(Boolean);
      },
      flush() {
        const rest = inCode ? '' : clean(buffer);
        buffer = '';
        inCode = false;
        return rest ? [rest] : [];
      },
      reset() {
        buffer = '';
        inCode = false;
      },
    };
  }

  /** 一句话切成几条字幕：优先在标点处断，实在太长再按字数断，英文不从单词中间断 */
  function lines(sentence, max = MAX_CHARS) {
    const result = [];
    let rest = clean(sentence).replace(/\s*\n\s*/g, ' ');
    while (rest.length > max) {
      const head = rest.slice(0, max + 1);
      let cut = -1;
      for (let i = head.length - 1; i >= max / 3; i--) {
        if ('，,、；;：:。！？!?）)'.includes(head[i])) { cut = i + 1; break; }
      }
      if (cut === -1) {
        const space = head.lastIndexOf(' ');
        cut = space >= max / 3 ? space + 1 : max;
      }
      result.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) result.push(rest);
    return result;
  }

  const readingMs = (line) => Math.max(MIN_LINE_MS, line.length * MS_PER_CHAR);

  const api = { clean, createSentenceStream, lines, readingMs, MAX_CHARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.SoulSubtitle = api;
})();
