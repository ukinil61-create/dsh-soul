/**
 * dsh-desk 桌面外壳 —— Electron 主进程
 *
 * 两个窗口：
 *   壁纸层：全屏，由 keeper 挂进 Progman 下的 WorkerW，真图标浮在它上面。平时就在这里。
 *   浮层：透明置顶、鼠标穿透。只在被窗口盖住时按快捷键或被唤醒时出现，说完消失。
 *
 * 令牌只存在于 process.env.DSH_DESK_TOKEN，页面拿不到，任何日志都不许出现它。
 */

const { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, powerMonitor, screen, session, shell, utilityProcess } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createEar, createMouth, createScribe, minimaxVoices } = require('./voice.cjs');

const ORIGIN = process.env.DSH_DESK_ORIGIN;
const TOKEN = process.env.DSH_DESK_TOKEN;

const STATE_DIR = path.join(os.homedir(), '.dsh', 'desk');
const CONFIG_FILE = path.join(STATE_DIR, 'soul.json');
const PAUSED_FLAG = path.join(STATE_DIR, 'paused');
const LOG = path.join(STATE_DIR, 'shell.log');
const WAKE_KEYWORDS = path.join(STATE_DIR, 'wake-keywords.txt');
const TRAY_ICON = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'tray.ico');
const KEEPER = path.join(__dirname, '..', 'keeper', 'dsh-desk-keeper.exe');
const KEEPER_PID = path.join(STATE_DIR, 'keeper.pid');
/** 开发模式：这个文件存在时开本机调试端口，tests/ 靠它驱动真实界面。平时不存在，由 tests/dev-mode.ps1 开关 */
const DEV_MODE = fs.existsSync(path.join(STATE_DIR, 'dev-mode'));
if (DEV_MODE) app.commandLine.appendSwitch('remote-debugging-port', '9339');

/** keeper 靠这两个标题找窗口 */
const SOUL_TITLE = 'DSH Soul';
const OVERLAY_TITLE = 'DSH Soul Overlay';
/** 加在标题后面的信号：壁纸层要键盘 / 浮层把前台还回去 */
const PANEL_TITLE = 'DSH Soul Panel';
const RAISE_SUFFIX = ' (raise)';
const RELEASE_SUFFIX = ' (release)';
const KEY_SUFFIX = ' (key:';

/** keeper 发来的窗口消息 */
const WM_FOCUS_PAGE = 0x8001;
const WM_DROP_OPEN = 0x8002;
const WM_DROP_CLOSE = 0x8003;
const WM_DESKTOP_FOREGROUND = 0x8004;
const WM_WHEEL = 0x8005;

/** 松手后再留一会儿，让拖放事件来得及送到 */
const DROP_LINGER_MS = 500;

const DEFAULT_CONFIG = {
  form: 'condense',
  looks: 'present',
  work: 'expand',
  speak: true,
  wake: true,
  speakers: ['zh_female_vv_uranus_bigtts', 'zh_female_sajiaoxuemei_uranus_bigtts'],
  // 语音模型。provider：volc 火山引擎，minimax 走用户本机配好的工具
  voice: {
    provider: 'volc',
    model: 'seed-tts-2.0',
    speaker: '',
    rate: 0,
    keyFile: '',
    minimax: {
      toolDir: '',
      model: 'speech-2.8-turbo',
      voice: 'Cantonese_CuteGirl',
      speed: 1,
    },
  },
  // 用哪个光点形象：内置方案的 id，或工作室保存的名字
  figure: { kind: 'preset', id: 'flow' },
  // 依次试，前面的被别的程序占了就用下一个
  hotkeys: ['Control+Alt+D', 'Control+Alt+Q', 'Control+Alt+F12'],
  voiceHotkeys: ['Control+Alt+V', 'Control+Alt+F11'],
  panelHotkeys: ['Control+Alt+S', 'Control+Alt+F10'],
};
/** 拼音拆成声母和带调韵母，这是唤醒模型要求的写法 */
const DEFAULT_WAKE_KEYWORDS = 'n ǐ h ǎo l íng h ún @你好灵魂\n';

fs.mkdirSync(STATE_DIR, { recursive: true });
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(STATE_DIR, 'electron-data'));
// 用 App 自己的身份发通知：名字和图标都是 DeepSeek Harness
app.setAppUserModelId('com.deepseek.dsh');
// 壁纸层在 Chromium 看来总是被盖住，不关掉遮挡判断就会停止绘制
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let soulWindow;
let overlay;
let dropZone;
let panel;
let panelReady = false;
let panelWanted = false;
let pendingPanelSession = null;
let tray;
let quitting = false;
let desktopInFront = false;
let summonedFromDesktop = false;
let overlayMode = 'hidden';
let config = { ...DEFAULT_CONFIG };
let answering = false;
let mouthBusy = false;
let ear;
let mouth;
let activeHotkey = '';
let activePanelHotkey = '';
let activeVoiceHotkey = '';
let soulName = '';
let birthAsked = false;
let lastVoiceAt = 0;
let voiceApproval = null;
let spokeThisAnswer = false;
let conversation = false;
let askWindow;
const askCards = [];
let scribe;

function log(line) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志写不了不影响灵魂 */
  }
}

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = {
      ...DEFAULT_CONFIG,
      ...saved,
      voice: { ...DEFAULT_CONFIG.voice, ...saved.voice, minimax: { ...DEFAULT_CONFIG.voice.minimax, ...saved.voice?.minimax } },
    };
  } catch {
    /* 没存过或存坏了：用默认值 */
  }
}

/** 写临时文件再换名：连着存两次也不会互相覆盖。文件写坏了，下次启动全部设置都会丢 */
function saveConfig() {
  const temp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2));
  fs.renameSync(temp, CONFIG_FILE);
}

function broadcast(event) {
  for (const win of [soulWindow, overlay]) {
    if (win && !win.isDestroyed()) win.webContents.send('soul:event', event);
  }
}

function presence(state) {
  broadcast({ kind: 'presence', state });
}

// ---- 和后台说话 ----

/** 页面能调用的后台路由。发到主线用 say 的逻辑，这里不开放语音和还原 */
/* '/official-url' 不开放给页面：地址里带登录令牌，只在主进程用 */
const PANEL_ROUTES = new Set([
  '/sessions', '/history', '/say', '/cancel', '/new', '/approval', '/model-catalog', '/select-model',
  '/rename', '/archive', '/fork', '/search', '/completions', '/command', '/question', '/permissions', '/autonomy', '/solo-now', '/rebirth', '/context',
  ...(DEV_MODE ? ['/dev-clone', '/stt'] : []),
]);
const PRESENCE_MS = 30000;
/** 别的置顶窗口被激活时会盖住浮层，显示期间隔这么久压回去 */
const OVERLAY_TOP_MS = 2000;
/** 这么久以内用嘴说过话，审批也用嘴问 */
const VOICE_CONVERSATION_MS = 5 * 60 * 1000;
const PANEL_MIN_WIDTH = 640;
const PANEL_MIN_HEIGHT = 400;
const PANEL_DRAG_MS = 16;
const PANEL_BACK_MS = 250;
/** 说这些才关监听（小蓝也是这几句）。这句话不发给模型。句尾的语气词先去掉：“就这样吧啊”也算 */
const END_WORDS = /^(结束|结束监听|结束对话|退下|关闭监听|别听|不听|就这样)$/;
const TRAILING_PARTICLES = /[啊呀吧了嘛哈哦呢]+$/;
/** 用户要说“结束”才关。这个只是兜底：忘了关时，别让麦克风一直把屋里的声音发给模型 */
const CONVERSATION_WAIT_MS = 5 * 60 * 1000;
/** 念完话音箱的余音 */
const ECHO_TAIL_MS = 300;
/** 问完“可以吗”等这么久。界面上一直能点，不用等太久 */
const APPROVAL_WAIT_MS = 8000;
const ASK_WIDTH = 420;
const ASK_HEIGHT = 170;
const ASK_MARGIN = 18;
/** 桌面露着时卡片在光的下面：和回车对话框同一个位置 */
const ASK_DESK_X = .6;
const ASK_DESK_Y = .7;
const TAB_TITLE = 'DSH Soul Tab';
const TAB_WIDTH = 24;
const TAB_HEIGHT = 72;
const SLIDE_STEPS = 9;
const SLIDE_FRAME_MS = 16;
const PASTE_DIR = path.join(os.homedir(), '.dsh', 'soul', 'pasted');
const FIGURES_DIR = path.join(STATE_DIR, 'figures');
const STUDIO_RESHOW_MS = 50;
/** 官方页面上方留给“返回”那一条 */
const OFFICIAL_TOP = 45;

function request(route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request(`${ORIGIN}/soul${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-soul-token': TOKEN },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch { /* 下面按失败处理 */ }
        if (res.statusCode === 200 && parsed.ok) resolve(parsed);
        else reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function settleIfQuiet() {
  if (answering || mouthBusy) return;
  ear?.setMuted(false);
  if (conversation) listenAgain();
  else presence('idle');
}

// ---- 对话模式：喊了名字就一直听，它说完接着听，不用再喊。说“结束”才关 ----

/** 接着听。麦克风开着时什么声音都可能发给模型，所以这时候光要一眼能看出来 */
function listenAgain() {
  broadcast({ kind: 'mic', on: true });
  ear.listenNow(ECHO_TAIL_MS);
  presence('hear');
}

/** 不出提示：光环消失就是关了 */
function endConversation(why) {
  if (!conversation) return;
  conversation = false;
  log(`conversation ended: ${why}`);
  ear.stopListening();
  if (!config.wake) broadcast({ kind: 'mic', on: false });
  broadcast({ kind: 'presence', state: 'idle', force: true });
}

function onHostEvent(event) {
  if (panel && !panel.isDestroyed()) panel.webContents.send('soul:event', { kind: 'session', event });
  if (event.type === 'approval') return onApproval(event);
  if (event.type === 'approval-closed') {
    if (voiceApproval?.approvalId === event.approvalId) voiceApproval = null;
    dropAskCard(event.approvalId);
  }
  if (event.type === 'question') callUser(event, '它有问题问你', event.questions[0]?.question ?? '');
  if (event.type === 'reborn') return onReborn();
  if (event.type === 'idle') {
    broadcast({ kind: 'idle', idle: event.idle });
    return undefined;
  }
  if (event.type === 'name') {
    useName(event.name);
    ear.reload();
    log('wake word changed');
    return undefined;
  }
  // 只有主线驱动光和声音，别的会话只在会话界面里显示
  if (!event.main) return undefined;
  if (event.type === 'delta') {
    if (!answering) {
      answering = true;
      spokeThisAnswer = false;
    }
    presence('speak');
    broadcast({ kind: 'delta', text: event.text, voiced: config.speak });
    if (config.speak) {
      mouthBusy = true;
      ear?.setMuted(true);
      mouth.feed(event.text);
    }
  } else if (event.type === 'tool') {
    presence('work');
    soulWindow.webContents.send('soul:event', { kind: 'tool', id: event.id, name: event.name, target: event.target, diff: event.diff });
  } else if (event.type === 'tool-result') {
    soulWindow.webContents.send('soul:event', { kind: 'tool-result', id: event.id, ok: event.ok });
  } else if (event.type === 'end') {
    answering = false;
    broadcast({ kind: 'end' });
    if (config.speak) mouth.flush();
    settleIfQuiet();
  }
  return undefined;
}

/** 桌面露着就直接打开会话界面；被窗口盖住就发系统通知，不抢用户正在做的事 */
/** 它从空白开始：名字和待机样子都回到默认，下一次有人看着桌面时它醒来 */
function onReborn() {
  useName('');
  ear.reload();
  broadcast({ kind: 'idle', idle: null });
  broadcast({ kind: 'rest', asleep: false });
  birthAsked = false;
  if (desktopInFront) wakeUp();
}

function wakeUp() {
  if (birthAsked) return;
  birthAsked = true;
  request('/birth').catch((error) => log(`birth failed: ${error.message}`));
}

function callUser(event, title, body) {
  // 测试开的会话不打断用户
  if (event.dev) return;
  if (desktopInFront || panelVisible()) {
    openPanel(event.sessionId);
    return;
  }
  const note = new Notification({ title, body, silent: false });
  note.on('click', () => openPanel(event.sessionId));
  note.show();
}

function onApproval(event) {
  log(`approval asked: ${event.toolName}`);
  if (event.main && config.speak && Date.now() - lastVoiceAt < VOICE_CONVERSATION_MS) askByVoice(event);
  // 测试开的会话不打断用户，它们的卡片只在会话界面里
  if (event.dev) return;
  askCards.push(event);
  syncAskCard();
}

// ---- 审批卡片：不用去会话窗口点。桌面露着就在光下面，窗口盖着就在右下角。都不抢键盘 ----

function createAskWindow() {
  askWindow = new BrowserWindow({
    width: ASK_WIDTH, height: ASK_HEIGHT, title: 'DSH Ask', frame: false, show: false, type: 'toolbar', skipTaskbar: true,
    alwaysOnTop: true, resizable: false, focusable: false, fullscreenable: false, backgroundColor: '#12151d',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), spellcheck: false },
  });
  askWindow.setAlwaysOnTop(true, 'screen-saver');
  askWindow.on('page-title-updated', (event) => event.preventDefault());
  askWindow.on('close', (event) => { if (!quitting) event.preventDefault(); });
  askWindow.webContents.once('did-finish-load', syncAskCard);
  askWindow.loadFile(path.join(__dirname, 'ask.html'));
}

function syncAskCard() {
  if (!askWindow || askWindow.isDestroyed() || askWindow.webContents.isLoading()) return;
  const card = askCards[0];
  // 用户正在会话窗口里时，那边已经有这张卡片了
  if (!card || (panelVisible() && panel.isFocused())) {
    askWindow.hide();
    return;
  }
  askWindow.webContents.send('soul:event', { kind: 'ask', card, more: askCards.length - 1 });
  const { bounds, workArea } = screen.getPrimaryDisplay();
  const x = desktopInFront ? bounds.width * ASK_DESK_X - ASK_WIDTH / 2 : workArea.x + workArea.width - ASK_WIDTH - ASK_MARGIN;
  const y = desktopInFront ? bounds.height * ASK_DESK_Y : workArea.y + workArea.height - ASK_HEIGHT - ASK_MARGIN;
  askWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: ASK_WIDTH, height: ASK_HEIGHT });
  if (!askWindow.isVisible()) askWindow.showInactive();
}

function dropAskCard(approvalId) {
  const at = askCards.findIndex((card) => card.approvalId === approvalId);
  if (at === -1) return;
  askCards.splice(at, 1);
  syncAskCard();
}

// ---- 用嘴批准：刚才是用语音说的，审批也问一句。只批准这一次；听不清就留着卡片 ----

function askByVoice(event) {
  voiceApproval = { approvalId: event.approvalId, asked: false };
  hush();
  mouthBusy = true;
  ear.setMuted(true);
  // 原因后面常跟一长串路径，念出来没法听，只念是哪类能力
  mouth.feed(`要${String(event.reason || event.toolName).split('：')[0]}，可以吗？`);
  mouth.flush();
}

/** 念完问题才开始听，不然会听到自己 */
function listenForApproval() {
  if (!voiceApproval || voiceApproval.asked) return;
  voiceApproval.asked = true;
  broadcast({ kind: 'mic', on: true });
  // 问的时候关了麦克风，这一轮还没结束所以没人打开，要在这里开，不然听不到回答
  ear.setMuted(false);
  ear.listenNow(0, APPROVAL_WAIT_MS);
  presence('hear');
}

/** “不”优先：不可以、不好、不行都算拒绝 */
function voiceVerdict(text) {
  if (/不|别|拒绝|算了|取消/.test(text)) return 'rejected';
  if (/可以|行|好|同意|批准|允许|对|嗯|是/.test(text)) return 'allowed-once';
  return null;
}

async function answerApprovalByVoice(text) {
  const { approvalId } = voiceApproval;
  voiceApproval = null;
  const outcome = voiceVerdict(text);
  log(`voice approval: ${outcome ?? 'unclear'}`);
  presence('think');
  // 没听清就留着卡片，点一下也行
  if (!outcome) return;
  await request('/approval', { approvalId, outcome }).catch((error) => log(`voice approval failed: ${error.message}`));
}

/** 后台的实时事件。宿主热重载时连接会断，等一下再连 */
function connectEvents() {
  const req = http.get(`${ORIGIN}/soul/events`, { headers: { 'x-soul-token': TOKEN } }, (res) => {
    if (res.statusCode !== 200) {
      log(`events refused: ${res.statusCode}`);
      res.resume();
      return;
    }
    log('events connected');
    showWaitingCards();
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!block.startsWith('data: ')) continue;
        try {
          onHostEvent(JSON.parse(block.slice(6)));
        } catch (error) {
          log(`bad event: ${error.message}`);
        }
      }
    });
    res.on('close', () => { if (!quitting) setTimeout(connectEvents, 3000); });
  });
  req.on('error', (error) => {
    log(`events failed: ${error.message}`);
    if (!quitting) setTimeout(connectEvents, 3000);
  });
}

/** 外壳重启前没答的卡片再拿出来，不然它会一直等一张看不见的卡片 */
async function showWaitingCards() {
  try {
    const { events } = await request('/waiting');
    if (!events.length) return;
    log(`cards still waiting: ${events.length}`);
    if (panel.webContents.isLoading()) await new Promise((done) => panel.webContents.once('did-finish-load', done));
    events.forEach(onHostEvent);
  } catch (error) {
    log(`waiting cards failed: ${error.message}`);
  }
}

/** 告诉后台用户在不在。它什么时候有自己的时间、留的话什么时候浮现，都由后台据此决定 */
function reportPresence() {
  request('/presence', { idleSeconds: powerMonitor.getSystemIdleTime(), desktopInFront })
    .then(({ asleep }) => broadcast({ kind: 'rest', asleep }))
    .catch((error) => log(`presence failed: ${error.message}`));
  superviseKeeper();
}

/** 互相保活：守护进程没了就叫回来。经 explorer 启动才不算外壳的子进程 */
function superviseKeeper() {
  if (fs.existsSync(PAUSED_FLAG)) return;
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(KEEPER_PID, 'utf8'));
    if (pid) {
      process.kill(pid, 0);
      return;
    }
  } catch {
    /* 没写过或进程不在了：都叫回来 */
  }
  if (!fs.existsSync(KEEPER)) return;
  log('keeper gone; starting it again');
  spawn('explorer.exe', [KEEPER], { detached: true, stdio: 'ignore' }).unref();
}

/** 对方开口了：正在念的立刻停 */
function hush() {
  mouth.stop();
  mouthBusy = false;
  ear.setMuted(false);
  broadcast({ kind: 'hush' });
}

/** shown 是显示在桌面上的话，默认就是发给它的话 */
async function say(text, shown = text) {
  hush();
  broadcast({ kind: 'you', text: shown });
  presence('think');
  try {
    await request('/say', { text });
  } catch (error) {
    log(`say failed: ${error.message}`);
    broadcast({ kind: 'error', message: `我没收到：${error.message}` });
    if (conversation) listenAgain();
    else presence('idle');
  }
}

// ---- 窗口 ----

function createSoulWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  soulWindow = new BrowserWindow({
    // 先放在屏幕外，keeper 挂进壁纸层时才摆回原点，开机不会闪一下黑屏
    x: -width - 100,
    y: 0,
    width,
    height,
    title: SOUL_TITLE,
    frame: false,
    thickFrame: false,
    show: false,
    // toolbar 类型在 Windows 上就是 WS_EX_TOOLWINDOW：不进任务栏，也不进 Alt+Tab
    type: 'toolbar',
    skipTaskbar: true,
    backgroundColor: '#000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false, spellcheck: false },
  });
  soulWindow.on('page-title-updated', (event) => event.preventDefault());
  soulWindow.on('close', (event) => { if (!quitting) event.preventDefault(); });
  // 资源管理器重启时父窗口被销毁。退出让插件重开，keeper 再挂到新桌面上
  soulWindow.on('closed', () => {
    if (quitting) return;
    log('soul window destroyed with its parent; exiting for restart');
    app.exit(1);
  });
  soulWindow.once('ready-to-show', () => soulWindow.showInactive());
  soulWindow.hookWindowMessage(WM_FOCUS_PAGE, (_wParam, lParam) => {
    const scale = screen.getPrimaryDisplay().scaleFactor || 1;
    const x = lParam.readInt16LE(0) / scale;
    const y = lParam.readInt16LE(2) / scale;
    soulWindow.webContents.focus();
    soulWindow.webContents.send('soul:event', { kind: 'focus', x: x > 0 ? x : null, y });
  });
  soulWindow.hookWindowMessage(WM_DESKTOP_FOREGROUND, (wParam) => {
    desktopInFront = wParam.readInt8(0) === 1;
    syncAskCard();
    // 第一次有人看着桌面时，它才醒来
    if (desktopInFront) wakeUp();
    // Win+D 会把顶层窗口藏起来。会话窗口是属于桌面的，桌面露出来时它还该在
    if (desktopInFront && panelVisible()) setTimeout(keepPanelOnDesktop, PANEL_BACK_MS);
  });
  soulWindow.hookWindowMessage(WM_DROP_OPEN, () => dropZone.showInactive());
  soulWindow.hookWindowMessage(WM_DROP_CLOSE, () => setTimeout(() => dropZone.hide(), DROP_LINGER_MS));
  soulWindow.hookWindowMessage(WM_WHEEL, (wParam) => {
    soulWindow.webContents.send('soul:event', { kind: 'wheel', delta: wParam.readInt32LE(0) });
  });
  soulWindow.webContents.on('console-message', (event) => { if (event.level === 'error' || /^mic/.test(event.message)) log(`soul page: ${event.message}`); });
  soulWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`soul renderer gone: ${details.reason}`);
    if (!quitting) soulWindow.reload();
  });
  soulWindow.loadFile(path.join(__dirname, 'soul.html'));
}

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  overlay = new BrowserWindow({
    x: 0, y: 0, width, height, title: OVERLAY_TITLE, frame: false, show: false, transparent: true, type: 'toolbar',
    skipTaskbar: true, alwaysOnTop: true, resizable: false, hasShadow: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), spellcheck: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  // 鼠标全部穿透到下面的窗口，键盘仍然进浮层
  overlay.setIgnoreMouseEvents(true);
  overlay.on('page-title-updated', (event) => event.preventDefault());
  overlay.on('close', (event) => { if (!quitting) event.preventDefault(); });
  overlay.on('blur', () => { if (overlayMode === 'input') hideOverlay(); });
  overlay.webContents.on('console-message', (event) => { if (event.level === 'error') log(`overlay page: ${event.message}`); });
  overlay.loadFile(path.join(__dirname, 'soul.html'), { query: { mode: 'overlay' } });
}

/** 壁纸层在图标层下面收不到拖放，拖动时在光的位置临时放一个透明的接收窗口 */
function createDropZone() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  const half = Math.round(height * .32);
  dropZone = new BrowserWindow({
    x: Math.round(width * .6) - half, y: Math.max(0, Math.round(height * .38) - half), width: half * 2, height: half * 2,
    frame: false, show: false, transparent: true, type: 'toolbar', skipTaskbar: true, alwaysOnTop: true,
    resizable: false, hasShadow: false, focusable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  dropZone.on('close', (event) => { if (!quitting) event.preventDefault(); });
  dropZone.loadFile(path.join(__dirname, 'drop.html'));
}

// ---- 会话界面：桌面窗口的子窗口，排在图标层之上，能点能打字；平时收起 ----

function defaultPanelBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const left = Math.round(area.width * .38);
  const margin = 20;
  return { x: left, y: area.y + margin, width: area.width - left - margin, height: area.height - margin * 2 };
}

/** 不小于能用的大小，也拖不出屏幕 */
function fitPanel({ x, y, width, height }) {
  const area = screen.getPrimaryDisplay().workArea;
  // 左边留出小按钮的位置，不然它会被窗口挡住
  const w = Math.min(area.width - TAB_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
  const h = Math.min(area.height, Math.max(PANEL_MIN_HEIGHT, Math.round(height)));
  return {
    x: Math.max(area.x + TAB_WIDTH, Math.min(area.x + area.width - w, Math.round(x))),
    y: Math.max(area.y, Math.min(area.y + area.height - h, Math.round(y))),
    width: w,
    height: h,
  };
}

function panelBounds() {
  return config.panelBounds ? fitPanel(config.panelBounds) : defaultPanelBounds();
}

/** 拖动中的鼠标位置在这里读：窗口跟着动，页面里的坐标会抖 */
let panelDrag = null;
let panelDragStart = null;

function dragPanel(edge) {
  if (panelDrag) clearInterval(panelDrag);
  panelDrag = null;
  // 不可改大小的窗口连程序也改不动，只在这时候放开
  panel.setResizable(Boolean(edge) && edge !== 'reset');
  if (edge === 'reset') {
    panel.setResizable(true);
    delete config.panelBounds;
    panel.setBounds(defaultPanelBounds());
    panel.setResizable(false);
    placeTab(panel.getBounds().x);
    saveConfig();
    return;
  }
  if (!edge) {
    // 只是点了一下头部，没有拖：不算改过位置
    const now = panel.getBounds();
    if (['x', 'y', 'width', 'height'].some((key) => now[key] !== panelDragStart?.[key])) {
      config.panelBounds = now;
      saveConfig();
    }
    return;
  }
  const from = screen.getCursorScreenPoint();
  const start = panel.getBounds();
  panelDragStart = start;
  panelDrag = setInterval(() => {
    const at = screen.getCursorScreenPoint();
    const dx = at.x - from.x;
    const dy = at.y - from.y;
    const next = { ...start };
    if (edge === 'move') { next.x += dx; next.y += dy; }
    if (edge === 'left') { next.x += dx; next.width -= dx; }
    if (edge === 'right') next.width += dx;
    if (edge === 'top') { next.y += dy; next.height -= dy; }
    if (edge === 'bottom') next.height += dy;
    panel.setBounds(fitPanel(next));
    placeTab(panel.getBounds().x);
    layoutOfficial();
  }, PANEL_DRAG_MS);
}

// ---- 右边的小按钮：桌面的子窗口，只在露出桌面时看得到。收着时贴屏幕右边，展开时贴会话窗口左边 ----

let tabWindow;
let slideTimer = null;

/** panelX 是会话窗口现在的左边；不给就是收着 */
function placeTab(panelX) {
  if (!tabWindow || tabWindow.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const right = area.x + area.width - TAB_WIDTH;
  const x = panelX === undefined ? right : Math.max(area.x, Math.min(right, panelX - TAB_WIDTH));
  tabWindow.setPosition(Math.round(x), area.y + Math.round((area.height - TAB_HEIGHT) / 2));
}

function createTab() {
  tabWindow = new BrowserWindow({
    x: 0, y: 0, width: TAB_WIDTH, height: TAB_HEIGHT,
    title: TAB_TITLE,
    frame: false,
    thickFrame: false,
    resizable: false,
    show: false,
    type: 'toolbar',
    skipTaskbar: true,
    backgroundColor: '#000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), spellcheck: false },
  });
  placeTab();
  tabWindow.on('page-title-updated', (event) => event.preventDefault());
  tabWindow.on('close', (event) => { if (!quitting) event.preventDefault(); });
  tabWindow.once('ready-to-show', () => tabWindow.showInactive());
  tabWindow.loadFile(path.join(__dirname, 'tab.html'));
}

function tellTab(open) {
  if (tabWindow && !tabWindow.isDestroyed()) tabWindow.webContents.send('soul:event', { kind: 'drawer', open });
}

/** 水平滑动，小按钮跟着走。中途再操作会接着当前位置滑 */
function slidePanel(toX, done) {
  clearInterval(slideTimer);
  const { x: fromX, y } = panel.getBounds();
  let step = 0;
  slideTimer = setInterval(() => {
    step += 1;
    const progress = 1 - (1 - step / SLIDE_STEPS) ** 2;
    const x = Math.round(fromX + (toX - fromX) * progress);
    panel.setPosition(x, y);
    placeTab(x);
    if (step < SLIDE_STEPS) return;
    clearInterval(slideTimer);
    slideTimer = null;
    done?.();
  }, SLIDE_FRAME_MS);
}

function panelVisible() {
  return Boolean(panel && !panel.isDestroyed() && panel.isVisible());
}

function createPanel() {
  panel = new BrowserWindow({
    ...panelBounds(),
    title: PANEL_TITLE,
    frame: false,
    thickFrame: false,
    // 能改大小的无边框窗口，边上几像素会被系统当成边框，点击到不了页面。改大小由页面的四条边发起
    resizable: false,
    minimizable: false,
    show: false,
    type: 'toolbar',
    skipTaskbar: true,
    backgroundColor: '#0d0e14',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false, spellcheck: false },
  });
  panel.on('page-title-updated', (event) => event.preventDefault());
  panel.on('close', (event) => { if (!quitting) event.preventDefault(); });
  panel.webContents.on('console-message', (event) => { if (event.level === 'error') log(`panel page: ${event.message}`); });
  panel.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  panel.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });
  panel.loadFile(path.join(__dirname, 'panel.html'));
}

/** 带上后缀是告诉 keeper：把桌面露出来，再把键盘交给会话界面 */
function raisePanel() {
  panel.setTitle(PANEL_TITLE + RAISE_SUFFIX);
  setTimeout(() => { if (!panel.isDestroyed()) panel.setTitle(PANEL_TITLE); }, 500);
}

function openPanel(sessionId) {
  if (!panelReady) {
    pendingPanelSession = sessionId ?? null;
    panelWanted = true;
    return;
  }
  const target = panelBounds();
  if (!panel.isVisible()) {
    panel.setPosition(offscreenX(), target.y);
    panel.showInactive();
  }
  slidePanel(target.x);
  tellTab(true);
  panel.webContents.send('soul:event', { kind: 'panel-open', sessionId });
  soulWindow.webContents.send('soul:event', { kind: 'panel', open: true });
  raisePanel();
}

function keepPanelOnDesktop() {
  if (!panelVisible() || !desktopInFront) return;
  if (panel.isMinimized()) panel.restore();
  panel.moveTop();
}

function closePanel() {
  if (!panelVisible()) return;
  tellTab(false);
  soulWindow.webContents.send('soul:event', { kind: 'panel', open: false });
  slidePanel(offscreenX(), () => {
    panel.hide();
    placeTab();
  });
}

const offscreenX = () => {
  const area = screen.getPrimaryDisplay().workArea;
  return area.x + area.width;
};

// ---- 官方页面：插件、自动化任务这些低频功能直接嵌在会话界面里，不用打开 App ----

let officialView;

function layoutOfficial() {
  if (!officialView) return;
  const { width, height } = panel.getContentBounds();
  officialView.setBounds({ x: 0, y: OFFICIAL_TOP, width, height: height - OFFICIAL_TOP });
}

async function openOfficial() {
  if (!officialView) {
    officialView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    officialView.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    officialView.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(ORIGIN)) {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    });
    // 官方页面里的 Esc 到不了会话界面，这里转一下，不然退不出来
    officialView.webContents.on('before-input-event', (_event, key) => {
      if (key.type === 'keyDown' && key.key === 'Escape') panel.webContents.send('soul:event', { kind: 'official-esc' });
    });
    const { url } = await request('/official-url', { origin: ORIGIN });
    await officialView.webContents.loadURL(url);
  }
  panel.contentView.addChildView(officialView);
  layoutOfficial();
  officialView.webContents.focus();
}

function closeOfficial() {
  if (officialView) panel.contentView.removeChildView(officialView);
  panel.webContents.focus();
}

// ---- 光点形象工作室：单独的普通窗口，设计存在 ~/.dsh/desk/figures ----

let studio;

const figurePath = (name) => path.join(FIGURES_DIR, `${String(name).replace(/[\\/:*?"<>|]/g, '_')}.json`);

function listFigures() {
  try {
    return fs.readdirSync(FIGURES_DIR).filter((file) => file.endsWith('.json')).map((file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(FIGURES_DIR, file), 'utf8'));
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** 把当前选中的形象发给页面。存的设计被删了就退回默认 */
function figureEvent() {
  if (config.figure?.kind === 'saved') {
    try {
      return { kind: 'figure', spec: JSON.parse(fs.readFileSync(figurePath(config.figure.id), 'utf8')) };
    } catch {
      log(`figure missing: ${config.figure.id}`);
    }
  }
  return { kind: 'figure', preset: config.figure?.id ?? 'flow' };
}

function openStudio() {
  if (studio && !studio.isDestroyed()) {
    studio.show();
    studio.focus();
    return;
  }
  studio = new BrowserWindow({
    x: 236,
    y: 95,
    width: 1280,
    height: 820,
    title: '光点形象工作室',
    show: false,
    backgroundColor: '#07080c',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), spellcheck: false },
  });
  studio.once('ready-to-show', () => {
    studio.show();
    studio.focus();
    // 实测第一次 show 之后窗口马上又变成不可见（没有 hide 事件），再来一次才稳定
    setTimeout(() => {
      if (!studio.isDestroyed() && !studio.isVisible()) studio.show();
    }, STUDIO_RESHOW_MS);
  });
  studio.loadFile(path.join(__dirname, 'studio.html'));
  studio.webContents.on('console-message', (event) => { if (event.level === 'error') log(`studio page: ${event.message}`); });
}

function currentSettings() {
  return {
    form: config.form,
    looks: config.looks,
    work: config.work,
    speak: config.speak,
    wake: config.wake,
    voice: config.voice,
    hotkeys: { panel: activePanelHotkey, summon: activeHotkey, voice: activeVoiceHotkey },
  };
}

function setHotkey(which, accelerator) {
  const current = { panel: activePanelHotkey, summon: activeHotkey, voice: activeVoiceHotkey }[which];
  const handler = { panel: togglePanel, summon: onHotkey, voice: onVoiceHotkey }[which];
  if (accelerator === current) return null;
  if (current) globalShortcut.unregister(current);
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, handler);
  } catch {
    ok = false;
  }
  if (!ok) {
    if (current) globalShortcut.register(current, handler);
    return `${accelerator} 用不了，可能被别的程序占用了`;
  }
  if (which === 'panel') { activePanelHotkey = accelerator; config.panelHotkeys = [accelerator]; }
  if (which === 'summon') { activeHotkey = accelerator; config.hotkeys = [accelerator]; }
  if (which === 'voice') { activeVoiceHotkey = accelerator; config.voiceHotkeys = [accelerator]; }
  saveConfig();
  return null;
}

function applySetting(key, value) {
  if (key === 'form') setForm(value);
  else if (key === 'looks') {
    config.looks = value;
    saveConfig();
    sendConfig();
  } else if (key === 'work') setWork(value);
  else if (key === 'speak') {
    config.speak = Boolean(value);
    saveConfig();
    if (!config.speak) { hush(); settleIfQuiet(); }
  } else if (key === 'wake') {
    config.wake = Boolean(value);
    saveConfig();
    if (!config.wake) endConversation('wake off');
    broadcast({ kind: 'mic', on: config.wake });
  } else if (key === 'voice') {
    config.voice = { ...config.voice, ...value, minimax: { ...config.voice.minimax, ...value.minimax } };
    saveConfig();
    mouth.resetVoice();
  } else if (key === 'hotkey') {
    return setHotkey(value.which, value.accelerator);
  }
  return null;
}

function getVoice() {
  const { speaker, ...rest } = config.voice;
  return { ...rest, speakers: speaker ? [speaker] : config.speakers };
}

function togglePanel() {
  // 被别的窗口盖着时按快捷键是要把它叫回来，不是收起
  if (panelVisible() && (desktopInFront || panel.isFocused())) closePanel();
  else openPanel();
}

function hideOverlay() {
  // 从桌面呼出的框关掉了，桌面上那团光不用再等着听
  if (overlayMode === 'input' && summonedFromDesktop && !answering) presence('idle');
  overlayMode = 'hidden';
  if (overlay.isVisible()) overlay.hide();
  overlay.setTitle(OVERLAY_TITLE);
  overlay.webContents.send('soul:event', { kind: 'bare', on: false });
  showWallLight(true);
}

/** 浮层上有光时壁纸上的就藏起来：窗口没盖满桌面时两个都看得见，就成了两个灵魂 */
function showWallLight(on) {
  if (!soulWindow.isDestroyed()) soulWindow.webContents.send('soul:event', { kind: 'bare', on: !on });
}

/** 说完话把键盘还给原来的窗口，浮层留着显示回答 */
function releaseOverlayFocus() {
  overlayMode = 'answer';
  overlay.setTitle(OVERLAY_TITLE + RELEASE_SUFFIX);
  setTimeout(() => { if (!overlay.isDestroyed()) overlay.setTitle(OVERLAY_TITLE); }, 300);
}

/** 输入框在浮层里：壁纸层是桌面的子窗口，不是前台窗口，输入法在那里切不了 */
function onHotkey() {
  if (overlayMode === 'input') { hideOverlay(); return; }
  // 从桌面呼出的，说完话浮层就收起来，回答显示在桌面上，不用两边各显示一遍
  summonedFromDesktop = desktopInFront;
  overlayMode = 'input';
  overlay.webContents.send('soul:event', { kind: 'summon', bare: summonedFromDesktop });
  showWallLight(summonedFromDesktop);
  overlay.show();
  overlay.focus();
  if (summonedFromDesktop) presence('listen');
  // 窗口一直盖着桌面时，它留的话这时候能看到
  request('/presence', { idleSeconds: 0, desktopInFront: true }).catch((error) => log(`presence failed: ${error.message}`));
}

/** 用嘴叫它时光留在壁纸上，不浮到窗口上面（用户试过，说不对） */
function startListening() {
  hush();
  conversation = true;
  presence('hear');
}

/** 在对话模式里再按一次就是关：不想开口说“结束”的时候用 */
function onVoiceHotkey() {
  if (conversation) {
    endConversation('hotkey');
    return;
  }
  broadcast({ kind: 'mic', on: true });
  ear.listenNow();
  startListening();
}

const plainWords = (text) => String(text).replace(/[\s\p{P}\p{S}]/gu, '').toUpperCase();

/** 名字带英文字母时，唤醒模型认不出（它是中文的），改成转文字找名字。纯中文名不走这里，不多耗资源 */
function useName(name) {
  soulName = name;
  const wanted = /[A-Za-z]/.test(name) ? plainWords(name) : '';
  ear.setSegmentListener(wanted ? (wav) => checkForName(wav, wanted) : null);
}

async function checkForName(wav, wanted) {
  const { text } = await request('/stt', { audio: wav.toString('base64') });
  const said = plainWords(text);
  if (!said.includes(wanted)) return;
  log(`wake word heard in speech: ${soulName}`);
  startListening();
  // 喊名字的同时就把话说了：这句就是要说的。只喊了名字才接着听
  if (said.length > wanted.length) {
    lastVoiceAt = Date.now();
    if (await handleEndWord(text)) return;
    await say(text);
  } else {
    broadcast({ kind: 'mic', on: true });
    ear.listenNow();
  }
}

/** 这句话是不是在叫它停。前面可能带着名字（录音往前多留了一秒） */
async function handleEndWord(text) {
  const name = soulName ? plainWords(soulName) : '';
  const said = plainWords(text).replace(name || '\0', '').replace(TRAILING_PARTICLES, '');
  if (!END_WORDS.test(said)) return false;
  endConversation('end word');
  return true;
}

/** 麦克风一直开着时，只听到名字或者一声“嗯”不算对它说话 */
function isNoise(text) {
  const said = plainWords(text);
  return !said || (soulName && said === plainWords(soulName)) || (conversation && /^[嗯啊哦呃唉哎诶噢]+$/.test(said));
}

function savedName() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'soul', 'name.json'), 'utf8')).name ?? '';
  } catch {
    return '';
  }
}

/** 先用更准的本机模型，没有或出错就用 DSH 自带的 */
async function hearWords(wav) {
  const better = await scribe.transcribe(wav);
  if (better !== null) return better;
  return (await request('/stt', { audio: wav.toString('base64') })).text;
}

async function onUtterance(wav) {
  presence('think');
  if (!config.wake && !conversation) broadcast({ kind: 'mic', on: false });
  try {
    const text = await hearWords(wav);
    log(`heard: ${String(text).slice(0, 40)}`);
    // 结束词先看：等批准时说“结束”是要关监听，不是在答批准。卡片还留着
    if (await handleEndWord(text)) return;
    if (plainWords(text) && voiceApproval) {
      await answerApprovalByVoice(text);
      return;
    }
    if (!isNoise(text)) {
      lastVoiceAt = Date.now();
      await say(text);
      return;
    }
    log('nothing to say');
  } catch (error) {
    log(`stt failed: ${error.message}`);
    broadcast({ kind: 'error', message: `我没听清：${error.message}` });
  }
  if (conversation) {
    listenAgain();
    return;
  }
  presence('idle');
  if (overlayMode === 'answer') hideOverlay();
}

// ---- 托盘 ----

function permissionMenu(state) {
  const levels = [['ask', '危险的才问我'], ['allow', '一直允许'], ['deny', '不允许']];
  return Object.entries(state.categories ?? {}).map(([category, label]) => ({
    label,
    submenu: levels.map(([level, text]) => ({
      label: text,
      type: 'radio',
      checked: (state.levels?.[category] ?? 'ask') === level,
      click: () => request('/permissions', { category, level }).catch((error) => log(`permission failed: ${error.message}`)),
    })),
  }));
}

function buildTrayMenu(state = {}) {
  if (state.name) soulName = state.name;
  return Menu.buildFromTemplate([
    // 快捷键都被占了时，这是进设置的唯一入口
    { label: activePanelHotkey ? `打开会话（${activePanelHotkey}）` : '打开会话', click: () => openPanel() },
    { label: '打开 App（备用）', click: () => shell.openExternal('dsh://open').catch(() => {}) },
    { type: 'separator' },
    {
      label: '平时的样子',
      submenu: [
        { label: '光凝成脸', type: 'radio', checked: config.form === 'condense', click: () => setForm('condense') },
        { label: '平时无形', type: 'radio', checked: config.form === 'formless', click: () => setForm('formless') },
      ],
    },
    {
      label: '干活时',
      submenu: [
        { label: '展开工作区', type: 'radio', checked: config.work === 'expand', click: () => setWork('expand') },
        { label: '只看到它在忙', type: 'radio', checked: config.work === 'quiet', click: () => setWork('quiet') },
      ],
    },
    { label: '还原桌面', click: restoreDesktop },
    { type: 'separator' },
    { label: '它能做什么', submenu: permissionMenu(state) },
    { label: '它的记录（身份、记忆、变化历史）', click: () => shell.openPath(path.join(os.homedir(), '.dsh', 'soul')) },
    { type: 'separator' },
    {
      label: '念出回答',
      type: 'checkbox',
      checked: config.speak,
      click: (item) => { config.speak = item.checked; saveConfig(); if (!item.checked) { hush(); settleIfQuiet(); } },
    },
    {
      label: `语音唤醒（说“${soulName || '你好灵魂'}”）`,
      type: 'checkbox',
      checked: config.wake,
      click: (item) => {
        config.wake = item.checked;
        saveConfig();
        if (!item.checked) endConversation('wake off');
        broadcast({ kind: 'mic', on: item.checked });
      },
    },
    { label: `快捷键：${activeHotkey || '没有可用的'}`, enabled: false },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings({ path: KEEPER }).openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, path: KEEPER, name: 'DshDesk' }),
    },
    {
      label: '退出',
      click: () => {
        fs.writeFileSync(PAUSED_FLAG, new Date().toISOString());
        quitting = true;
        app.quit();
      },
    },
  ]);
}

const configEvent = () => ({ kind: 'config', form: config.form, looks: config.looks, work: config.work });

function sendConfig() {
  broadcast(configEvent());
}

function setForm(form) {
  config.form = form;
  saveConfig();
  sendConfig();
}

function setWork(work) {
  config.work = work;
  saveConfig();
  sendConfig();
}

async function restoreDesktop() {
  try {
    const { text } = await request('/restore');
    broadcast({ kind: 'notice', text });
  } catch (error) {
    log(`restore failed: ${error.message}`);
    broadcast({ kind: 'notice', text: `还原失败：${error.message}` });
  }
}

function createTray() {
  tray = new Tray(fs.existsSync(TRAY_ICON) ? nativeImage.createFromPath(TRAY_ICON) : nativeImage.createEmpty());
  tray.setToolTip('DeepSeek Harness 灵魂');
  tray.on('click', onHotkey);
  tray.on('right-click', async () => {
    const state = await request('/permissions').catch(() => ({}));
    tray.popUpContextMenu(buildTrayMenu(state));
  });
}

function registerHotkey(list, handler) {
  for (const accelerator of list) {
    if (globalShortcut.register(accelerator, handler)) return accelerator;
    log(`hotkey taken: ${accelerator}`);
  }
  return '';
}

if (!ORIGIN || !TOKEN) {
  // 只能由插件带着令牌拉起
  log('started without host credentials; exiting');
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  ipcMain.on('soul:say', (event, text) => {
    if (BrowserWindow.fromWebContents(event.sender) === overlay) {
      if (summonedFromDesktop) hideOverlay();
      else releaseOverlayFocus();
    }
    say(String(text));
  });
  ipcMain.on('soul:summon', onHotkey);
  ipcMain.on('soul:cancel', () => request('/cancel').catch((error) => log(`cancel failed: ${error.message}`)));
  ipcMain.on('soul:dismiss', hideOverlay);
  ipcMain.on('soul:drag-over', (_event, over) => presence(over ? 'listen' : 'idle'));
  ipcMain.on('soul:drop', (_event, paths) => {
    if (!paths.length) return;
    log(`received ${paths.length} dropped item(s)`);
    // tests/physical.ps1 拖的测试文件，不进主线
    if (DEV_MODE && paths.every((file) => path.basename(file).startsWith('__soul_drop_test'))) return;
    say(`用户把这些文件交给了你：\n${paths.join('\n')}`, paths.map((p) => path.basename(p)).join('、'));
  });
  ipcMain.handle('soul:api', (event, route, body) => {
    if (BrowserWindow.fromWebContents(event.sender) !== panel || !PANEL_ROUTES.has(route)) throw new Error('rejected');
    return request(route, body);
  });
  ipcMain.handle('soul:pick-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return canceled ? null : (filePaths[0] ?? null);
  });
  ipcMain.on('soul:close-panel', closePanel);
  ipcMain.on('soul:toggle-drawer', () => (panelVisible() ? closePanel() : openPanel()));
  ipcMain.on('soul:panel-drag', (_event, edge) => dragPanel(edge));
  ipcMain.on('soul:desktop-key', (event, key) => {
    // 剪贴板里是文件才交给桌面粘贴；是文字就还粘贴到输入框
    if (key === '^V' && !clipboard.readBuffer('FileNameW').length) {
      event.sender.paste();
      return;
    }
    soulWindow.setTitle(`${SOUL_TITLE}${KEY_SUFFIX}${key})`);
    setTimeout(() => { if (!soulWindow.isDestroyed()) soulWindow.setTitle(SOUL_TITLE); }, 300);
  });
  ipcMain.on('soul:open-studio', openStudio);
  ipcMain.handle('soul:minimax-voices', () => minimaxVoices(config.voice.minimax.toolDir));
  ipcMain.handle('soul:figures-list', () => ({ saved: listFigures(), active: config.figure }));
  ipcMain.handle('soul:figure-save', (_event, spec) => {
    fs.mkdirSync(FIGURES_DIR, { recursive: true });
    fs.writeFileSync(figurePath(spec.name), JSON.stringify(spec, null, 2));
    if (config.figure?.kind === 'saved' && config.figure.id === spec.name) broadcast(figureEvent());
    return { saved: listFigures(), active: config.figure };
  });
  ipcMain.handle('soul:figure-delete', (_event, name) => {
    fs.rmSync(figurePath(name), { force: true });
    if (config.figure?.kind === 'saved' && config.figure.id === name) {
      config.figure = DEFAULT_CONFIG.figure;
      saveConfig();
      broadcast(figureEvent());
    }
    return { saved: listFigures(), active: config.figure };
  });
  ipcMain.handle('soul:figure-use', (_event, choice) => {
    config.figure = choice;
    saveConfig();
    broadcast(figureEvent());
    // 让桌面上立刻看到效果，几秒后回到平时的样子
    broadcast({ kind: 'preview-figure' });
    return { saved: listFigures(), active: config.figure };
  });
  ipcMain.handle('soul:settings-get', () => currentSettings());
  ipcMain.handle('soul:settings-set', (_event, key, value) => {
    const error = applySetting(key, value);
    return { error, settings: currentSettings() };
  });
  ipcMain.on('soul:voice-test', () => {
    hush();
    mouthBusy = true;
    ear.setMuted(true);
    mouth.feed('这是现在的声音。');
    mouth.flush();
  });
  ipcMain.handle('soul:official-open', () => openOfficial());
  ipcMain.on('soul:official-close', closeOfficial);
  ipcMain.on('soul:open-records', () => shell.openPath(path.join(os.homedir(), '.dsh', 'soul')));
  ipcMain.handle('soul:paste-image', (_event, bytes) => {
    fs.mkdirSync(PASTE_DIR, { recursive: true });
    const file = path.join(PASTE_DIR, `${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(bytes));
    return file;
  });
  ipcMain.on('soul:ready', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) === panel) {
      panelReady = true;
      if (panelWanted) { panelWanted = false; openPanel(pendingPanelSession ?? undefined); }
      return;
    }
    event.sender.send('soul:event', configEvent());
    event.sender.send('soul:event', figureEvent());
    request('/idle').then(({ idle }) => { if (idle) event.sender.send('soul:event', { kind: 'idle', idle }); }).catch(() => {});
    if (config.wake && BrowserWindow.fromWebContents(event.sender) === soulWindow) event.sender.send('soul:event', { kind: 'mic', on: true });
  });
  ipcMain.on('soul:audio-ended', (_event, id) => mouth.played(id));
  ipcMain.on('soul:caption', (_event, text, ms) => broadcast({ kind: 'caption', text, ms }));
  ipcMain.on('soul:mic', (_event, samples) => ear.feed(samples, config.wake));

  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    scribe?.stop();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // 嵌进来的官方页面跟随系统主题，这里定成深色，和会话界面一致
    nativeTheme.themeSource = 'dark';
    loadConfig();
    if (!fs.existsSync(WAKE_KEYWORDS)) fs.writeFileSync(WAKE_KEYWORDS, DEFAULT_WAKE_KEYWORDS);

    const allowed = new Set(['media']);
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));

    scribe = createScribe({ fork: utilityProcess.fork, log });
    ear = createEar({
      keywordFile: WAKE_KEYWORDS,
      log,
      onWake: startListening,
      onUtterance,
      onGiveUp: () => {
        const wasApproval = voiceApproval;
        voiceApproval = null;
        // 没答复批准只是这件事等着，界面上还能点。对话没结束，它这一轮做完会接着听
        if (wasApproval && conversation) {
          presence('think');
          return;
        }
        if (conversation) {
          endConversation('nobody spoke');
          return;
        }
        presence('idle');
        if (overlayMode === 'answer') hideOverlay();
      },
      waitMs: CONVERSATION_WAIT_MS,
    });
    useName(savedName());
    mouth = createMouth({
      getVoice,
      log,
      onAudio: (id, bytes, text) => {
        log(`spoke sentence ${id}: ${bytes.length} bytes`);
        spokeThisAnswer = true;
        if (!soulWindow.isDestroyed()) soulWindow.webContents.send('soul:event', { kind: 'audio', id, bytes, text });
      },
      onIdle: () => {
        mouthBusy = false;
        if (!spokeThisAnswer) broadcast({ kind: 'voice-gone' });
        settleIfQuiet();
        listenForApproval();
      },
    });

    createSoulWindow();
    createOverlay();
    createDropZone();
    createAskWindow();
    createPanel();
    createTab();
    createTray();
    activeHotkey = registerHotkey(config.hotkeys, onHotkey);
    activeVoiceHotkey = registerHotkey(config.voiceHotkeys, onVoiceHotkey);
    activePanelHotkey = registerHotkey(config.panelHotkeys, togglePanel);
    log(`soul up; hotkey=${activeHotkey || 'none'} voice=${activeVoiceHotkey || 'none'} panel=${activePanelHotkey || 'none'}`);
    const missing = [['打开会话', activePanelHotkey], ['在窗口上说话', activeHotkey], ['直接用语音说', activeVoiceHotkey]].filter(([, key]) => !key).map(([name]) => name);
    if (missing.length) {
      new Notification({ title: '有快捷键用不了', body: `${missing.join('、')}的快捷键都被别的程序占了。右键托盘图标打开会话，到“设置和更多”里换一个。` }).show();
    }
    connectEvents();
    setInterval(reportPresence, PRESENCE_MS);
    setInterval(() => { if (overlay.isVisible()) overlay.moveTop(); }, OVERLAY_TOP_MS);
  });
}
