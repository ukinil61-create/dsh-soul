// 壁纸层和窗口上的浮层共用这一页：一个显示光和文字，收键盘和麦克风；浮层只是透明版。

(() => {
  const isOverlay = new URLSearchParams(location.search).get('mode') === 'overlay';
  if (isOverlay) {
    document.documentElement.classList.add('overlay');
    document.body.classList.add('overlay');
  }
  const say = document.getElementById('say');
  const you = document.getElementById('you');
  const soul = document.getElementById('soul');
  const host = window.soulHost;

  const light = window.createLight(document.getElementById('light'), isOverlay
    ? { cx: .5, cy: .34, scale: .62, transparent: true }
    : { cx: .6, cy: .38, scale: 1, transparent: false });

  const MIN_HOLD_MS = 20000;

  let form = 'condense';
  let state = 'idle';
  let answerEnded = false;
  let holdTimer;
  let youTimer;

  const setState = (next) => {
    state = next;
    document.body.dataset.state = next;
    light.set(form, state);
  };

  // ---- 字幕：桌面上任何时候只有一条短句。有声音时跟着声音走，没有声音时按阅读速度走 ----
  // 完整的回答在会话界面里（Ctrl+Alt+S）

  const { createSentenceStream, lines: captionLines, readingMs } = window.SoulSubtitle;
  const stream = createSentenceStream();
  const captionQueue = [];
  let captionTimer = null;
  let fadeWanted = false;
  /** 这段回答在念：字幕等声音来带，句子先存着，声音出不来才用 */
  let voiced = false;
  let captioned = false;
  let backlog = [];

  function showLine(text) {
    soul.textContent = text;
    soul.classList.remove('gone');
    // 回答开始了，用户说的那句让开
    you.classList.add('gone');
    if (!isOverlay) work.style.paddingBottom = document.body.classList.contains('workOpen') ? `${soul.offsetHeight + 18}px` : '';
  }

  function nextCaption() {
    const item = captionQueue.shift();
    if (!item) {
      captionTimer = null;
      if (fadeWanted) fadeAnswerLater();
      return;
    }
    showLine(item.text);
    captionTimer = setTimeout(nextCaption, item.ms);
  }

  /** totalMs 是这句话的声音有多长，没有声音时不给，按字数算 */
  function queueCaption(text, totalMs) {
    const rows = captionLines(text);
    const chars = rows.join('').length || 1;
    for (const row of rows) captionQueue.push({ text: row, ms: totalMs ? (totalMs * row.length) / chars : readingMs(row) });
    if (!captionTimer) nextCaption();
  }

  function clearCaptions() {
    captionQueue.length = 0;
    clearTimeout(captionTimer);
    captionTimer = null;
    fadeWanted = false;
  }

  function newAnswer() {
    clearCaptions();
    clearTimeout(holdTimer);
    stream.reset();
    backlog = [];
    captioned = false;
    answerEnded = false;
  }

  const takeSentence = (sentence) => {
    if (voiced) backlog.push(sentence);
    else queueCaption(sentence);
  };

  /** 回答完不立刻收：形象和最后一条字幕留一阵，到点再一起收回。字幕还没走完就等它走完 */
  function fadeAnswerLater() {
    clearTimeout(holdTimer);
    fadeWanted = Boolean(captionTimer);
    if (fadeWanted) return;
    holdTimer = setTimeout(() => {
      soul.classList.add('gone');
      if (state === 'linger') setState('idle');
      // 浮层上用户正在打字时不收，输入框会跟着消失
      if (isOverlay) setTimeout(() => { if (say.hidden) host.dismiss(); }, 1300);
      else collapseWork();
    }, MIN_HOLD_MS);
  }

  function showYou(text) {
    you.textContent = text;
    you.classList.remove('gone');
    clearTimeout(youTimer);
    youTimer = setTimeout(() => you.classList.add('gone'), 5000);
  }

  /**
   * 壁纸层上输入框收起时不是真的隐藏，而是透明地留着焦点：
   * 输入法只在有可编辑的焦点时才跟着切换，真隐藏了，回车之前切中英文就没反应
   */
  const ghosted = () => (isOverlay ? say.hidden : say.hidden || say.classList.contains('ghost'));

  function closeInput() {
    say.value = '';
    if (isOverlay) {
      say.hidden = true;
    } else if (!say.hidden) {
      say.classList.add('ghost');
    }
  }

  /** 点了空白桌面：输入框不出现，只是让键盘（和输入法）落在页面上 */
  function takeKeyboard() {
    if (isOverlay || !ghosted()) return;
    say.hidden = false;
    say.classList.add('ghost');
    say.focus();
  }

  /** x、y 是用户点的位置；点在固定输入区附近或没有位置时，就放到固定输入区 */
  function openInput(x, y) {
    say.hidden = false;
    say.classList.remove('ghost');
    // 从桌面呼出时放在桌面那团光的下面
    const centered = isOverlay && !document.body.classList.contains('bare');
    const fixedX = innerWidth * (centered ? .5 : .6);
    const fixedY = innerHeight * (centered ? .56 : .7);
    const nearFixed = x == null || (Math.abs(x - fixedX) < innerWidth * .2 && Math.abs(y - fixedY) < 80);
    const halfWidth = innerWidth * .23;
    const floor = screen.availHeight - 60;
    say.style.left = `${nearFixed ? fixedX : Math.min(innerWidth - halfWidth, Math.max(halfWidth, x))}px`;
    say.style.top = `${nearFixed ? fixedY : Math.min(floor, Math.max(0, y - 18))}px`;
    say.focus();
  }

  /** 输入框还空着时，这些键是给桌面的：粘贴文件、全选、撤销、重做、新建文件夹、刷新 */
  function desktopKey(event) {
    if (isOverlay || say.value || event.altKey) return null;
    if (event.key === 'F5') return 'F5';
    if (!event.ctrlKey) return null;
    const letter = event.key.toUpperCase();
    if (event.shiftKey) return letter === 'N' ? '^+N' : null;
    return ['V', 'A', 'Z', 'Y'].includes(letter) ? `^${letter}` : null;
  }

  say.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const key = desktopKey(event);
    if (key) {
      event.preventDefault();
      host.desktopKey(key);
      return;
    }
    if (!isOverlay && say.classList.contains('ghost')) {
      if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        host.summon();
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const text = say.value.trim();
      // 空着按回车也算数：把框收起来，下一次回车再出来
      closeInput();
      if (text) host.say(text);
      else if (isOverlay) host.dismiss();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeInput();
      if (isOverlay) host.dismiss();
    }
  });
  /**
   * 回到桌面后键盘就在页面上（守护进程在没有选中图标时交过来；选中了图标，回车仍是打开它）。
   * 回车呼出真正的输入框：它在浮层窗口里，浮层是正经的前台窗口，输入法才能切换
   */
  document.addEventListener('keydown', (event) => {
    if (isOverlay || !say.hidden || event.key !== 'Enter' || event.isComposing || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    host.summon();
  });
  say.addEventListener('input', () => {
    // 壁纸层上的透明框只接回车，别的输入丢掉
    if (say.classList.contains('ghost')) say.value = '';
    if (state === 'idle') setState('listen');
  });
  say.addEventListener('blur', () => {
    if (!say.value.trim()) closeInput();
    if (state === 'listen') setState('idle');
  });

  // ---- 麦克风：16k 单声道音频块送主进程，唤醒词和录音都在那边 ----
  let micContext;
  let micStream;
  async function setMic(on) {
    if (!on) {
      micStream?.getTracks().forEach((track) => track.stop());
      micContext?.close();
      micStream = micContext = undefined;
      return;
    }
    if (micContext) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      micContext = new AudioContext({ sampleRate: 16000 });
      const source = micContext.createMediaStreamSource(micStream);
      const processor = micContext.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        const samples = new Float32Array(event.inputBuffer.getChannelData(0));
        host.micChunk(samples);
        // 监听时光环跟着声音起伏
        if (state === 'hear') {
          let sum = 0;
          for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
          light.setLevel(Math.sqrt(sum / samples.length));
        }
      };
      source.connect(processor);
      processor.connect(micContext.destination);
      console.log('mic on');
    } catch (error) {
      console.error(`mic failed: ${error.message}`);
    }
  }

  // ---- 念出来：音频由主进程合成后送来，一段接一段放 ----
  const audioQueue = [];
  let playing = null;
  function playNext() {
    if (playing || !audioQueue.length) return;
    const { id, bytes, text } = audioQueue.shift();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    const audio = new Audio(url);
    playing = audio;
    // 声音真的响起来才换字幕；经主进程转一下，浮层也要显示
    audio.addEventListener('playing', () => host.caption(text, Number.isFinite(audio.duration) ? audio.duration * 1000 : 0), { once: true });
    const finish = () => {
      if (playing !== audio) return;
      URL.revokeObjectURL(url);
      playing = null;
      host.audioEnded(id);
      playNext();
    };
    audio.onended = finish;
    audio.onerror = finish;
    audio.play().catch(finish);
  }

  function stopAudio() {
    audioQueue.length = 0;
    const audio = playing;
    playing = null;
    audio?.pause();
  }

  // ---- 干活：工作区和进度只画在壁纸层上，浮层不显示 ----
  const work = document.getElementById('work');
  const workBody = document.getElementById('workBody');
  const workTitle = document.getElementById('workTitle');
  const workClose = document.getElementById('workClose');
  const busy = document.getElementById('busy');
  const busyText = document.getElementById('busyText');
  const busyMore = document.getElementById('busyMore');
  let workMode = 'expand';
  let working = false;
  let stepCount = 0;
  let manualOpen = false;
  let panelOpen = false;
  /** 一行命令不值得弹东西：做了这么多步或这么久，工作区和“在忙”才出现 */
  const WORK_SHOW_STEPS = 3;
  const WORK_SHOW_MS = 10000;
  /** 做完了留这么久让人看一眼就收。用户自己点开的不收 */
  const WORK_LINGER_MS = 5000;
  let workLong = false;
  let workLongTimer;
  let workCloseTimer;

  const hit = (element, x, y) => {
    const r = element.getBoundingClientRect();
    return x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8;
  };

  function showWork(open) {
    work.classList.toggle('shut', !open);
    document.body.classList.toggle('workOpen', open);
    document.body.classList.toggle('open', panelOpen && !open);
    if (!open) work.style.paddingBottom = '';
    light.setOpen(open || panelOpen);
  }

  function syncWork() {
    // 干完后还没收回时保持打开，由 collapseWork 来收
    const open = working ? ((workMode === 'expand' && workLong) || manualOpen) : manualOpen;
    showWork(open);
    busy.classList.toggle('gone', !(working && workLong && !open));
  }

  function resetWork() {
    working = false;
    manualOpen = false;
    workLong = false;
    clearTimeout(workLongTimer);
    clearTimeout(workCloseTimer);
    stepCount = 0;
    workBody.textContent = '';
    syncWork();
  }

  function addStep({ id, name, target, diff }) {
    clearTimeout(workCloseTimer);
    if (!working) {
      clearTimeout(workLongTimer);
      workLongTimer = setTimeout(() => { workLong = true; syncWork(); }, WORK_SHOW_MS);
    }
    working = true;
    stepCount++;
    if (stepCount >= WORK_SHOW_STEPS) workLong = true;
    workBody.querySelector('.step.running')?.classList.remove('running');
    const row = document.createElement('div');
    row.className = 'step running';
    row.dataset.id = id;
    const mark = document.createElement('b');
    mark.textContent = String(stepCount);
    const label = document.createElement('span');
    label.textContent = target ? `${name}  ${target}` : name;
    row.append(mark, label);
    workBody.append(row);
    if (diff) {
      const box = document.createElement('div');
      box.className = 'diff';
      for (const [cls, text] of [['del', diff.before], ['add', diff.after]]) {
        if (!text) continue;
        const part = document.createElement('span');
        part.className = cls;
        part.textContent = text;
        box.append(part);
      }
      workBody.append(box);
    }
    workBody.scrollTop = workBody.scrollHeight;
    workTitle.textContent = `正在做 · 第 ${stepCount} 步`;
    busyText.textContent = `第 ${stepCount} 步：${target || name}`;
    syncWork();
  }

  function finishWork() {
    if (!working) return;
    working = false;
    clearTimeout(workLongTimer);
    workBody.querySelector('.step.running')?.classList.remove('running');
    workTitle.textContent = `做完了 · 共 ${stepCount} 步`;
    busy.classList.add('gone');
    workCloseTimer = setTimeout(collapseWork, WORK_LINGER_MS);
  }

  /** 自动展开的自己收；用户自己点开的留着，由用户收 */
  function collapseWork() {
    if (!working && !manualOpen) syncWork();
  }

  /** 壁纸层收不到鼠标，点击位置由 keeper 转来。返回 true 表示这次点击被工作区用掉了 */
  function clickOnWork(x, y) {
    if (x == null) return false;
    if (!busy.classList.contains('gone') && hit(busyMore, x, y)) {
      manualOpen = true;
      syncWork();
      return true;
    }
    if (work.classList.contains('shut')) return false;
    if (hit(workClose, x, y)) {
      manualOpen = false;
      showWork(false);
      if (working) busy.classList.remove('gone');
      return true;
    }
    return hit(work, x, y);
  }

  host.onEvent((event) => {
    switch (event.kind) {
      case 'config':
        form = event.form;
        workMode = event.work;
        light.setLooks(event.looks);
        light.set(form, state);
        if (!isOverlay) syncWork();
        break;
      case 'idle':
        light.setIdle(event.idle);
        break;
      case 'rest':
        light.setRest(event.asleep);
        break;
      case 'preview-figure':
        if (!isOverlay && soul.classList.contains('gone')) {
          setState('linger');
          setTimeout(() => { if (state === 'linger' && soul.classList.contains('gone')) setState('idle'); }, 6000);
        }
        break;
      case 'figure': {
        const spec = event.spec ?? window.SoulFigurePresets.find((preset) => preset.id === event.preset);
        if (spec) light.setFigure(spec);
        break;
      }
      case 'panel':
        // 会话界面打开时，光和文字让到它左边
        panelOpen = event.open;
        document.body.classList.toggle('open', panelOpen && work.classList.contains('shut'));
        light.setOpen(panelOpen || !work.classList.contains('shut'));
        break;
      case 'tool':
        addStep(event);
        break;
      case 'tool-result':
        if (event.ok === false) {
          [...workBody.querySelectorAll('.step')].find((row) => row.dataset.id === String(event.id))?.classList.add('failed');
        }
        break;
      case 'wheel':
        if (!work.classList.contains('shut')) workBody.scrollTop -= event.delta;
        break;
      case 'notice':
        newAnswer();
        queueCaption(event.text);
        fadeAnswerLater();
        break;
      case 'presence':
        // 关监听是立刻回到待机，字不留着
        if (event.force) {
          clearCaptions();
          clearTimeout(holdTimer);
          soul.classList.add('gone');
          you.classList.add('gone');
        }
        // 回答还在桌面上时不散，等它收回
        if (event.state === 'idle' && !event.force && !soul.classList.contains('gone')) {
          setState('linger');
          fadeAnswerLater();
        } else {
          setState(event.state);
        }
        break;
      case 'focus':
        // 点桌面只是把键盘接过来，不出输入框和光标；按回车才出（见上面的 keydown）
        if (!clickOnWork(event.x, event.y)) takeKeyboard();
        break;
      case 'bare':
        document.body.classList.toggle('bare', event.on);
        break;
      case 'summon':
        document.body.classList.toggle('bare', Boolean(event.bare));
        newAnswer();
        soul.classList.add('gone');
        you.classList.add('gone');
        openInput();
        break;
      case 'you':
        newAnswer();
        soul.classList.add('gone');
        showYou(event.text);
        if (!isOverlay) resetWork();
        break;
      case 'delta':
        // 它自己开口时没有“你说”这一步，上一段说完了就是新的一段
        if (answerEnded) newAnswer();
        voiced = Boolean(event.voiced);
        stream.push(event.text).forEach(takeSentence);
        break;
      case 'end':
        answerEnded = true;
        stream.flush().forEach(takeSentence);
        fadeAnswerLater();
        if (!isOverlay) finishWork();
        break;
      case 'caption':
        // 声音响到哪句，字幕就是哪句，之前没走完的不要了
        captioned = true;
        clearCaptions();
        clearTimeout(holdTimer);
        queueCaption(event.text, event.ms);
        // 声音常常比“这段回答结束”来得晚，念完最后一句还要收
        fadeWanted = answerEnded;
        break;
      case 'voice-gone':
        // 这段回答一句都没念出来（没有密钥、合成失败），字幕改成自己走
        if (!captioned) backlog.forEach((sentence) => queueCaption(sentence));
        backlog = [];
        break;
      case 'error':
        newAnswer();
        queueCaption(event.message);
        fadeAnswerLater();
        break;
      case 'mic':
        if (!isOverlay) setMic(event.on);
        break;
      case 'audio':
        if (!isOverlay) { audioQueue.push(event); playNext(); }
        break;
      case 'hush':
        clearCaptions();
        if (!isOverlay) stopAudio();
        break;
      default:
        break;
    }
  });

  addEventListener('focus', () => { if (!say.hidden) say.focus(); });
  setState('idle');
  host.ready();
})();
