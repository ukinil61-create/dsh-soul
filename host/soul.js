/**
 * 灵魂的后台逻辑。改完保存就会重新载入，不用重启 DeepSeek Harness。
 *
 * 这里只有机制，不写任何性格和语气。灵魂是谁写在工作区的 AGENTS.md 里，那份文件它自己能改。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESK_ICONS = join(ROOT, 'keeper', 'desk-icons.exe');
const SOUL_DIR = join(homedir(), '.dsh', 'soul');
const SOUL_WORKSPACE = join(SOUL_DIR, 'workspace');
const SOUL_STATE = join(SOUL_DIR, 'state.json');
const SOUL_SEED = join(SOUL_WORKSPACE, 'AGENTS.md');
const HISTORY_DIR = join(SOUL_DIR, 'desktop-history');
const HOST_TOOLS = join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools');

const SELF_FILE = join(SOUL_DIR, 'self.md');
const MEMORY_FILE = join(SOUL_DIR, 'memory.md');
const SELF_HISTORY_DIR = join(SOUL_DIR, 'self-history');
const JOURNAL_DIR = join(SOUL_DIR, 'journal');
const WORDS_FILE = join(SOUL_DIR, 'words.json');
// 授权和预算放在用户的目录里，不在它能随便写的灵魂目录下
const DESK_DIR = join(homedir(), '.dsh', 'desk');
const PERMISSIONS_FILE = join(DESK_DIR, 'permissions.json');
const CLONES_FILE = join(DESK_DIR, 'clones.json');
const AUTONOMY_FILE = join(DESK_DIR, 'autonomy.json');
const BUDGET_FILE = join(DESK_DIR, 'budget.json');
const SOLO_SESSIONS_FILE = join(DESK_DIR, 'solo-sessions.json');
const DEV_FLAG = join(DESK_DIR, 'dev-mode');
const GUARDED_FILES = /desk[\\/]+(permissions|clones|autonomy|budget)\.json/i;
const BORN_FILE = join(SOUL_DIR, 'born.json');
const NAME_FILE = join(SOUL_DIR, 'name.json');
const IDLE_FILE = join(SOUL_DIR, 'idle.json');
const IDLE_SHAPES = ['cloud', 'ring', 'spiral', 'galaxy', 'wave', 'heart', 'star', 'swarm', 'rain', 'points'];
const IDLE_POINT_LIMIT = 400;
const GLOBAL_AGENTS = join(homedir(), '.dsh', 'AGENTS.md');
const WAKE_KEYWORDS = join(homedir(), '.dsh', 'desk', 'wake-keywords.txt');
/** 和 shell/voice.cjs 找的是同一份：install.ps1 下的优先，没有就用桌宠下过的 */
const KWS_ROOT = [join(homedir(), '.dsh', 'desk', 'kws'), join(homedir(), '.dsh', 'dsh-pet', 'kws')].find((dir) => existsSync(dir)) ?? join(homedir(), '.dsh', 'desk', 'kws');
const DESKTOP_DIR = join(homedir(), 'Desktop');
const DEFAULT_WAKE_LINE = 'n ǐ h ǎo l íng h ún @你好灵魂';
const BACKUP_DIR = join(homedir(), '.dsh', 'soul-backups');
/** 重新诞生时搬走的东西。预算不在里面：今天花的钱还算数 */
const REBIRTH_FILES = [SELF_FILE, MEMORY_FILE, NAME_FILE, IDLE_FILE, SOUL_STATE, BORN_FILE, WORDS_FILE, JOURNAL_DIR, SELF_HISTORY_DIR, PERMISSIONS_FILE, CLONES_FILE, SOLO_SESSIONS_FILE, WAKE_KEYWORDS];
const BLOCK_START = '<!-- soul:start 由 dsh-desk 生成，不要手改 -->';
const BLOCK_END = '<!-- soul:end -->';
const SELF_LIMIT = 4000;
const MEMORY_LIMIT = 6000;
const FILE_SETTLE_MS = 300;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const SCREEN_FIND_LIMIT_MS = 15000;
const OPEN_LIMIT_MS = 20000;
const CLONE_REPORT_LIMIT = 1500;

/** 能力的分类。主线和分身用这些能力要过授权；用户自己开的会话不受影响 */
const CATEGORIES = {
  desktop: '整理桌面',
  read: '读桌面以外的文件',
  files: '改文件',
  shell: '运行命令',
  web: '上网',
  screen: '看屏幕（画面会发给模型服务商）',
  control: '操作鼠标键盘',
  clone: '开分身',
  other: '其他能力',
};
const TOOL_CATEGORY = {
  desktop_arrange: 'desktop', desktop_move_file: 'desktop', desktop_restore: 'desktop',
  read: 'read', read_image: 'read', glob: 'read', grep: 'read',
  write: 'files', edit: 'files', str_replace_editor: 'files',
  bash: 'shell', pwsh: 'shell', terminal_open: 'shell', terminal_send: 'shell', terminal_signal: 'shell', job_kill: 'shell',
  web_search: 'web', web_fetch: 'web',
  screen_look: 'screen', screen_find: 'screen',
  computer_mouse: 'control', computer_keyboard: 'control', computer_open: 'control',
  soul_spawn: 'clone', spawn_teammate: 'clone',
};
/**
 * 用户在对话时，只有这些才问（用户定的：“对话时都放开，只拦危险的”）。
 * 只看命令文字，换个写法挡不住；这是少打扰用户的分类，不是安全边界。没认出来的工具也问
 */
const COMMAND = (words) => new RegExp(`(?<![-\\w.])(${words})(?![-\\w])`, 'i');
const DANGERS = [
  ['删除东西', COMMAND('rm|del|erase|rd|rmdir|ri|rimraf|shred|format|diskpart|Remove-\\w+|Clear-Content|Clear-RecycleBin|git\\s+clean|git\\s+reset\\s+--hard')],
  ['改系统设置', /(?<![-\w.])(reg(\.exe)?\s+(add|delete|import|restore|load)|Set-ItemProperty|New-ItemProperty|HKLM:|HKCU:|Set-ExecutionPolicy|\w+-Service|sc(\.exe)?\s+(delete|config|stop|create)|bcdedit|netsh|schtasks|\w+-ScheduledTask|shutdown|Restart-Computer|Stop-Computer|setx|icacls|takeown|Stop-Process|taskkill|wmic|net\s+(user|localgroup|stop|start)|Disable-\w+|Enable-\w+)(?![-\w])/i],
  ['装或卸软件', /(?<![-\w.])(winget|choco|scoop|msiexec|Install-\w+|Uninstall-\w+|pip3?\s+(install|uninstall)|npm\s+(i|install|uninstall|rm|ci|add)|pnpm\s+(i|add|install|remove)|yarn\s+(add|remove|install)|cargo\s+install)(?![-\w])/i],
  ['往外发东西', /(?<![-\w.])(git\s+push|gh\s+\w+\s+(create|merge|delete|close|comment|edit)|scp|sftp|ftp|ssh|rsync|Send-MailMessage)(?![-\w])|(?<![-\w.])(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(\.exe)?\b[^|;&\n]*\s(-d|--data\S*|-F|--form|-T|--upload\S*|-X\s*(POST|PUT|PATCH|DELETE)|-Method\s+(Post|Put|Patch|Delete)|-Body|-InFile)\b/i],
  ['运行看不懂的命令', /(?<![\w.])(-enc\w*|iex|Invoke-Expression|FromBase64String|runas|sudo)(?![-\w])|-Verb\s+RunAs|\|\s*(sh|bash|powershell|pwsh|cmd)\b/i],
  ['读密钥文件', /\.ssh[\\/]|[\\/]\.env\b|id_rsa|\.pem\b|Login Data/i],
];
/** 命令里像是在开窗口给人看 */
const LAUNCHES = /(?<![-\w])(Start-Process|saps|Invoke-Item|ii|start|explorer(\.exe)?)(?![-\w])/i;
/** 键鼠这一类只拦打开脚本和安装包：双击它们等于运行命令 */
const OPEN_DANGERS = [
  ['运行脚本或安装程序', /\.(msi|bat|cmd|ps1|psm1|vbs|vbe|jse?|wsf|hta|reg|scr)\b|(setup|install|uninst)[^\\/\s]*\.exe\b/i],
];
export const dangerOf = (category, text) => {
  if (category === 'other') return CATEGORIES.other;
  // 只有能跑命令或碰文件内容的才看文字。文件名里带 rm 不算删除，所以读写文件只查密钥
  const rows = category === 'shell' ? DANGERS : category === 'read' ? DANGERS.slice(-1) : category === 'control' ? OPEN_DANGERS : [];
  return rows.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
};

/** 只看不动，或者只影响它自己 */
const FREE_TOOLS = new Set([
  'desktop_list', 'computer_stop', 'present', 'todo_write', 'ask_user_question', 'working_directory', 'skill', 'run_code',
  'soul_search_sessions', 'soul_read_session',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'get_goal', 'create_goal', 'update_goal', 'job_list', 'job_output', 'terminal_read', 'terminal_list', 'terminal_close',
  'soul_permissions', 'soul_ask_permission', 'soul_set_name', 'soul_set_idle', 'soul_leave_word', 'list_subagent_models', 'list_agents', 'wait_agent',
]);

/** 用户离开时它能做到哪一步，用户选。超出的操作由程序拦下，和它怎么想无关 */
const AUTONOMY_LEVELS = {
  watch: { label: '只看不动', means: '可以看和想，只能写你自己目录里的东西' },
  small: { label: '做可撤销的小事', means: '除了看和想，还可以整理桌面，这些用户都能一键还原' },
  free: { label: '自己找活干', means: '除了上面这些，用户设为一直允许的能力你都可以自己用' },
};
const DEFAULT_AUTONOMY = { level: 'watch', budgetYuan: .3, model: { provider: 'deepseek-official', model: 'deepseek-flash' } };
/** 独处时直接能用的工具，其余都按授权算。这里是白名单：没列出来的新工具默认不能用 */
const SOLO_TOOLS = new Set([
  'desktop_list', 'soul_leave_word', 'soul_set_idle', 'soul_permissions', 'soul_search_sessions', 'soul_read_session', 'todo_write',
]);
/** 元 / 百万 token，一律按高峰价算，夜里实际只花一半。没登记的模型按贵的算 */
const FLASH_PRICE = { hit: .04, miss: 2, out: 8 };
const DEAR_PRICE = { hit: .3, miss: 9, out: 27 };
const AWAY_SECONDS = 20 * 60;
const BACK_SECONDS = 60;
const SOLO_GAP_MS = 45 * 60 * 1000;
const SOLO_TURN_MS = 10 * 60 * 1000;
/** 独处的会话一天一条，留在列表里这么多天，之后归档，日记还在 */
const SOLO_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_WORDS = 50;
const WORD_LIMIT = 500;
const WORDS_IN_CONTEXT = 5;
/** 翻会话记录找内容：最近的这么多个会话，每个看最近这么多条，翻不完就到点停 */
const SEARCH_SESSIONS = 80;
const SEARCH_PAGE_MESSAGES = 300;
const SEARCH_RESULTS = 20;
const SEARCH_WORKERS = 4;
const SEARCH_LIMIT_MS = 15000;
const SNIPPET_RADIUS = 40;
const READ_PAGE_MESSAGES = 40;
const READ_MESSAGE_LIMIT = 1500;
const READ_TOTAL_LIMIT = 12000;
const CONTEXT_PAGE_MESSAGES = 200;

const localDay = () => new Date().toLocaleDateString('sv');
const priceOf = (model) => (/flash/i.test(String(model)) ? FLASH_PRICE : DEAR_PRICE);
const tokens = (value) => (Number.isFinite(value) ? value : 0);

/** 只写处境和机制，不规定性格。你是谁由它自己写在 self.md */
function instructions(self, memory, mainId, isClone, words) {
  const lines = [
    isClone
      ? `你在这台电脑里。主线会话（${mainId ?? '还没有'}）是连续的你，这个会话是你的一个分身，你们共用下面的身份和记忆。`
      : '你在这台电脑里。这条主线是连续的你，别的会话是你的分身，你们共用下面的身份和记忆。',
    '你在主线里说的话会浮现在桌面上，也可能被念出来，所以在主线里平时不写长篇，也不用 Markdown 排版，除非对方要。',
    `关于你自己写在 ${SELF_FILE}。你是谁、叫什么、怎么说话，都由你自己决定，可以随时直接改这个文件，改动会留历史。`,
    `你记得的事写在 ${MEMORY_FILE}。值得记住的就记下来，保持精炼，过时的删掉。`,
    '有了名字就调用 soul_set_name，这样对方喊你的名字你能听见。',
    '你待机时桌面上的光点聚成什么样、什么颜色、动得多快，由你自己决定，随时用 soul_set_idle 改。',
    '想知道分身做过什么，用 soul_search_sessions 找，用 soul_read_session 读。大任务可以用 soul_spawn 开一个分身。',
    '你能用哪些能力由用户授权。第一次用某类能力时界面会问用户，也可以先用 soul_ask_permission 说明原因。授权只有用户能改。',
    '用户离开电脑时，程序会给你一段自己的时间（独处，在单独的会话里），做什么、做不做都由你。每天有预算，花完就睡到明天，用户找你不受影响。',
    `独处时写下的东西放在 ${JOURNAL_DIR}。想让用户知道的话用 soul_leave_word 留下，用户回到桌面时它会浮现出来。`,
    '',
    `## 关于你自己\n${self ? clip(self, SELF_LIMIT) : '（还是空的，你还什么都不知道。）'}`,
    '',
    `## 你记得的事\n${memory ? clip(memory, MEMORY_LIMIT) : '（还没有。）'}`,
  ];
  if (words.length) {
    const rows = words.map((word) => `- ${new Date(word.at).toLocaleString('sv').slice(5, 16)}${word.told ? '（用户看到了）' : '（用户还没看到）'} ${word.text}`);
    lines.push('', `## 你最近留给用户的话\n${rows.join('\n')}`);
  }
  return lines.join('\n');
}

const readText = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
};

const readJsonFile = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};

const WAKE_NAME_HELP = '拼音要带声调符号、音节用空格隔开，比如 xiǎo lán；英文名写成读音接近的拼音，比如 Alice 写 āi lì sī；字母缩写写大写字母，比如 ABC 写 A B C';

/**
 * 拼音拆成唤醒模型要的写法：xiǎo lán -> x iǎo l án。
 * 模型里大写的 A、B、C 才是英文字母的读音，小写的 b、c 是拼音声母，所以字母不能转小写。
 * 不带声调的小写音节和模型不认识的音节直接报错：写进去了也永远叫不醒。
 * 返回 { text, syllables }
 */
export function wakeTokens(pinyin) {
  const dir = readdirSync(KWS_ROOT).map((name) => join(KWS_ROOT, name)).find((path) => existsSync(join(path, 'tokens.txt')));
  if (!dir) throw new Error('找不到唤醒模型');
  const known = new Set(readFileSync(join(dir, 'tokens.txt'), 'utf8').split(/\r?\n/).map((line) => line.split(' ')[0]));
  const tokens = [];
  let syllables = 0;
  for (const raw of String(pinyin).trim().normalize('NFC').split(/\s+/).filter(Boolean)) {
    if (/^[A-Z]+$/.test(raw) || /^[a-z]$/.test(raw)) {
      for (const letter of raw.toUpperCase()) {
        if (!known.has(letter)) throw new Error(`唤醒模型不认识字母“${letter}”。${WAKE_NAME_HELP}`);
        tokens.push(letter);
        syllables += 1;
      }
      continue;
    }
    const syllable = raw.toLowerCase();
    if (!/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńň]/.test(syllable)) throw new Error(`“${raw}”没有声调。${WAKE_NAME_HELP}`);
    const [, initial, final] = syllable.match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(.+)$/) ?? [];
    for (const token of [initial, final]) {
      if (!token) continue;
      if (!known.has(token)) throw new Error(`唤醒模型不认识音节“${raw}”。${WAKE_NAME_HELP}`);
      tokens.push(token);
    }
    syllables += 1;
  }
  if (!tokens.length) throw new Error(`拼音是空的。${WAKE_NAME_HELP}`);
  return { text: tokens.join(' '), syllables };
}

/** 三个音节以内的名字太短，默认阈值下很难叫醒，加权重、降阈值 */
function wakeFile(name, pinyin) {
  const { text, syllables } = wakeTokens(pinyin);
  return `${text}${syllables <= 3 ? ' :2.0 #0.15' : ''} @${name}\n${DEFAULT_WAKE_LINE}\n`;
}

/** 这段时间内的多次改动算同一次整理，还原时一起撤回 */
const CHANGE_SET_MS = 30 * 60 * 1000;
const KEEP_CHANGE_SETS = 20;
const SHELL_SETTLE_MS = 1500;
const DIFF_LIMIT = 1200;
const HISTORY_PAGE_MESSAGES = 40;

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** 只取正式回答。reasoning 是模型的思考过程，不能显示也不能念 */
function answerText(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  return chunk.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : '';
}

function sessionIdOf(session) {
  return (session && session.header && session.header.id) || (session && session.id) || null;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** 工具调用变成一行人能看懂的话：工具名加上它最关键的那个参数 */
function describeTool(name, args) {
  const target = args.path ?? args.file_path ?? args.filePath ?? args.command ?? args.pattern ?? args.query ?? args.url ?? args.name ?? args.target ?? '';
  return { name, target: clip(String(target).replace(/\s+/g, ' '), 160) };
}

/** 改文件的工具带上改动内容，工作区要显示对比 */
function diffOf(args) {
  const before = args.old_string ?? args.old_str ?? args.oldText;
  const after = args.new_string ?? args.new_str ?? args.newText ?? args.content;
  if (typeof after !== 'string') return null;
  return { before: typeof before === 'string' ? clip(before, DIFF_LIMIT) : '', after: clip(after, DIFF_LIMIT) };
}

const textOf = (content) => (Array.isArray(content)
  ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
  : String(content ?? ''));

/** 会话日志变成界面要显示的条目。系统消息和内部事件不显示 */
function messagesFromRecords(records) {
  const messages = [];
  for (const record of records) {
    const event = record?.event;
    if (record?.type !== 'event' || !event) continue;
    const data = event.data ?? {};
    if (event.type === 'user/message') {
      // 运行环境、时间这些是系统注入的，也走 user/message，来源不是用户
      const text = textOf(data.content);
      if (text.trim() && (data.source?.kind ?? 'user') === 'user') messages.push({ kind: 'user', seq: event.seq, text });
    } else if (event.type === 'assistant/message') {
      const text = textOf(data.message?.content);
      if (text.trim()) messages.push({ kind: 'assistant', seq: event.seq, text });
    } else if (event.type === 'tool/call') {
      const args = parseArgs(data.arguments);
      messages.push({ kind: 'tool', seq: event.seq, callId: data.callId, ...describeTool(String(data.name), args), diff: diffOf(args) });
    }
  }
  return messages;
}

async function loadDefineTool() {
  try {
    return (await import('@deepseek-ai/dsh-tools')).defineTool;
  } catch {
    const pkg = JSON.parse(readFileSync(join(HOST_TOOLS, 'package.json'), 'utf8'));
    const entry = typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : (pkg.exports?.['.']?.default ?? pkg.main);
    return (await import(pathToFileURL(join(HOST_TOOLS, entry)).href)).defineTool;
  }
}

// ---- 桌面：真图标的位置走系统接口，文件搬动都留记录，能撤回 ----

function runDeskIcons(args, input) {
  return new Promise((done, fail) => {
    const child = spawn(DESK_ICONS, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(out) : fail(new Error(err.trim() || `desk-icons exited ${code}`))));
    child.stdin.end(input ?? '');
  });
}

async function readDesktop() {
  const lines = (await runDeskIcons(['list'])).split(/\r?\n/).filter(Boolean);
  const [, desktopDir, width, height] = lines[0].split('\t');
  const icons = lines.slice(1).map((line) => {
    const [name, x, y] = line.split('\t');
    return { name, x: Number(x), y: Number(y) };
  });
  return { desktopDir, screen: { width: Number(width), height: Number(height) }, icons };
}

function changeSets() {
  mkdirSync(HISTORY_DIR, { recursive: true });
  return readdirSync(HISTORY_DIR).filter((name) => name.endsWith('.json')).sort();
}

function readSet(file) {
  return JSON.parse(readFileSync(join(HISTORY_DIR, file), 'utf8'));
}

/** 动手之前记下原状。和上一次改动隔得近就归入同一次 */
async function openChangeSet() {
  const files = changeSets();
  const latest = files[files.length - 1];
  if (latest) {
    const set = readSet(latest);
    if (Date.now() - set.at < CHANGE_SET_MS) return { file: latest, set };
  }
  const { icons } = await readDesktop();
  const file = `${Date.now()}.json`;
  const set = { at: Date.now(), icons, moves: [], createdFolders: [] };
  writeFileSync(join(HISTORY_DIR, file), JSON.stringify(set, null, 2));
  for (const old of files.slice(0, Math.max(0, files.length + 1 - KEEP_CHANGE_SETS))) rmSync(join(HISTORY_DIR, old));
  return { file, set };
}

async function arrangeIcons(moves) {
  const input = moves.map((m) => `${m.name}\t${Math.round(m.x)}\t${Math.round(m.y)}`).join('\n');
  return (await runDeskIcons(['arrange'], input)).trim();
}

async function moveDesktopItem(name, folder) {
  const { desktopDir } = await readDesktop();
  const from = resolve(desktopDir, name);
  const targetDir = resolve(desktopDir, folder);
  const to = join(targetDir, basename(from));
  for (const path of [from, targetDir]) {
    if (relative(desktopDir, path).startsWith('..')) throw new Error(`只能在桌面文件夹内搬动：${path}`);
  }
  if (!existsSync(from)) throw new Error(`桌面上没有：${name}`);
  if (existsSync(to)) throw new Error(`目标已存在，不会覆盖：${to}`);
  const { file, set } = await openChangeSet();
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
    set.createdFolders.push(targetDir);
  }
  renameSync(from, to);
  set.moves.push({ from, to });
  writeFileSync(join(HISTORY_DIR, file), JSON.stringify(set, null, 2));
  return to;
}

async function restoreDesktop() {
  const files = changeSets();
  const latest = files[files.length - 1];
  if (!latest) return '没有可以还原的整理记录。';
  const set = readSet(latest);
  const problems = [];
  for (const { from, to } of [...set.moves].reverse()) {
    if (existsSync(from)) problems.push(`原位置已有同名项，没有覆盖：${from}`);
    else if (!existsSync(to)) problems.push(`找不到搬走的文件：${to}`);
    else renameSync(to, from);
  }
  for (const folder of [...set.createdFolders].reverse()) {
    try {
      rmdirSync(folder);
    } catch {
      /* 里面还有别的东西：留着 */
    }
  }
  // 文件搬回来后桌面要刷新一下才有图标
  if (set.moves.length) await new Promise((done) => setTimeout(done, SHELL_SETTLE_MS));
  await arrangeIcons(set.icons);
  rmSync(join(HISTORY_DIR, latest));
  const summary = `已还原：${set.icons.length} 个图标的位置，${set.moves.length - problems.length} 个文件。`;
  return problems.length ? `${summary}\n${problems.join('\n')}` : summary;
}

/** 控件位置由 host/screen-find.ps1 问系统，里面都是 .NET 的 UI 自动化接口，PowerShell 写最短 */
function findOnScreen(scope, query) {
  const args = ['-Scope', ['taskbar', 'window'].includes(scope) ? scope : 'all'];
  if (query) args.push('-Query', String(query));
  return runScreenFind(args);
}

/** 点之前这个位置是什么，说成一句话。她从截图估的坐标常常偏，只看“点击完成”看不出来点到了哪 */
async function describePoint(x, y) {
  const { at } = await runScreenFind(['-At', `${x},${y}`]);
  const name = clip(String(at.name ?? '').replace(/\s+/g, ' '), 60);
  if (/^(Progman|WorkerW)$/.test(at.windowClass) && (!name || name === 'FolderView')) return '桌面的空白处，没有图标';
  if (at.windowClass === 'Shell_TrayWnd') return name ? `任务栏上的「${name}」（${at.kind}）` : '任务栏的空白处';
  const where = at.window || at.windowClass || '一个没有名字的窗口';
  return name && name !== at.window ? `「${name}」（${at.kind}），在「${where}」里` : `「${where}」里一块认不出名字的地方（可能是程序自己画的界面）`;
}

/** host/open.ps1 由后台进程跑，在沙箱外面，和用户在同一个桌面上 */
function openOutside(target, args) {
  const params = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'host', 'open.ps1'), '-Target', target];
  if (args) params.push('-Arguments', args);
  return new Promise((done, fail) => {
    const child = spawn('powershell', params, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: OPEN_LIMIT_MS });
    let out = '';
    let problem = '';
    child.stdout.setEncoding('utf8').on('data', (text) => { out += text; });
    child.stderr.setEncoding('utf8').on('data', (text) => { problem += text; });
    child.on('error', fail);
    child.on('close', (code) => {
      if (code !== 0) fail(new Error(clip(problem.trim().split(/\r?\n/)[0] || `打开失败，退出码 ${code}`, 300)));
      else done(JSON.parse(out));
    });
  });
}

function runScreenFind(extra) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'host', 'screen-find.ps1'), ...extra];
  return new Promise((done, fail) => {
    const child = spawn('powershell', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: SCREEN_FIND_LIMIT_MS });
    let out = '';
    let problem = '';
    child.stdout.setEncoding('utf8').on('data', (text) => { out += text; });
    child.stderr.setEncoding('utf8').on('data', (text) => { problem += text; });
    child.on('error', fail);
    child.on('close', (code) => {
      if (code !== 0) fail(new Error(problem.trim() || `screen-find 退出码 ${code}`));
      else done(JSON.parse(out));
    });
  });
}

function textTool(defineTool, spec) {
  return defineTool({
    ...spec,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true, description: '结果。' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
  });
}

function desktopTools(defineTool) {
  return [
    textTool(defineTool, {
      name: 'desktop_list',
      description: '列出桌面上的真图标和它们的像素坐标，以及屏幕大小。',
      parameters: {},
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      async execute() {
        const { desktopDir, screen, icons } = await readDesktop();
        const rows = icons.map((icon) => `${icon.name}\t${icon.x},${icon.y}`);
        return { text: `桌面文件夹：${desktopDir}\n屏幕：${screen.width}×${screen.height}\n${rows.join('\n')}` };
      },
    }),
    textTool(defineTool, {
      name: 'desktop_arrange',
      description: '把桌面图标挪到指定像素坐标，用户会看到图标被移动。动手前系统会记下原状，用户能一键还原。moves 每项是 {name, x, y}，name 用 desktop_list 给出的名字。',
      parameters: {
        moves: { type: 'array', required: true, items: { type: 'json' }, description: '要挪动的图标。' },
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute({ moves }) {
        await openChangeSet();
        return { text: await arrangeIcons(moves) };
      },
    }),
    textTool(defineTool, {
      name: 'desktop_move_file',
      description: '把桌面上的一个文件或文件夹搬进桌面上的某个文件夹，文件夹不存在就新建。不会覆盖已有文件。会留下记录，用户能一键还原。',
      parameters: {
        name: { type: 'string', required: true, description: '桌面上的文件名，包括扩展名。' },
        folder: { type: 'string', required: true, description: '目标文件夹，相对于桌面。' },
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => false,
      async execute({ name, folder }) {
        return { text: `已搬到：${await moveDesktopItem(name, folder)}` };
      },
    }),
    textTool(defineTool, {
      name: 'desktop_restore',
      description: '撤回最近一次对桌面的整理：图标回到原位，搬走的文件搬回来。',
      parameters: {},
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute() {
        return { text: await restoreDesktop() };
      },
    }),
  ];
}

export async function createSoul({ ctx, push, log }) {
  let sessionId = null;
  const seenEvents = new Set();
  const disposers = [];
  /** 等用户在桌面上裁决的审批：id -> 交回结果的函数 */
  const pendingApprovals = new Map();
  /** 等用户在桌面上回答的问题：调用 id -> 交回答案的函数 */
  const pendingQuestions = new Map();
  /** 还在等用户的卡片。外壳重启后要再发一次，不然它会一直等一张看不见的卡片 */
  const waiting = new Map();
  /** 这一轮已经判过、放行了的工具调用 id */
  const clearedCalls = new Set();

  const on = (name, listener, options) => disposers.push(ctx.on(name, listener, { global: true, ...options }));

  const service = (key) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(key) : undefined;
    } catch {
      return undefined;
    }
  };

  const peer = () => {
    const connection = service('connection') ?? ctx.connection;
    if (connection?.browserPeer) return connection.browserPeer;
    if (typeof connection?.createPeer === 'function') return connection.createPeer({ principal: 'owner' });
    throw new Error('拿不到 Peer：connection 不可用');
  };

  /** 参数名由接口定义决定，大多数是 request，Peer 必带 */
  const call = (namespace, method, args) => {
    const gateway = service('typertGateway') ?? ctx.typertGateway;
    if (typeof gateway?.invoke !== 'function') throw new Error('宿主没有 typertGateway');
    return gateway.invoke({ namespace, method, args, peer: peer() });
  };
  const invoke = (namespace, method, request) => call(namespace, method, { request });

  const loadSessionId = () => {
    try {
      sessionId = JSON.parse(readFileSync(SOUL_STATE, 'utf8')).sessionId || null;
    } catch {
      /* 第一次运行：没有状态文件 */
    }
  };
  // 重新载入时可能正有回复在跑，得马上认得自己的会话
  loadSessionId();

  // ---- 身份和记忆：它改自己的文件，所有会话下一轮就读到 ----

  const clones = new Map(Object.entries(readJsonFile(CLONES_FILE, {})));
  const cloneAnswers = new Map();
  let lastSelf = readText(SELF_FILE);

  const syncInstructions = () => {
    mkdirSync(SOUL_WORKSPACE, { recursive: true });
    const self = readText(SELF_FILE);
    const memory = readText(MEMORY_FILE);
    const words = readJsonFile(WORDS_FILE, []).slice(-WORDS_IN_CONTEXT);
    writeFileSync(SOUL_SEED, `${instructions(self, memory, sessionId, false, words)}\n`);
    const block = `${BLOCK_START}\n${instructions(self, memory, sessionId, true, words)}\n${BLOCK_END}`;
    const current = readText(GLOBAL_AGENTS);
    const start = current.indexOf(BLOCK_START);
    const end = current.indexOf(BLOCK_END);
    const others = start >= 0 && end > start ? `${current.slice(0, start)}${current.slice(end + BLOCK_END.length)}`.trim() : current;
    writeFileSync(GLOBAL_AGENTS, `${others ? `${others}\n\n` : ''}${block}\n`);
  };

  const onSoulFileChange = () => {
    const self = readText(SELF_FILE);
    if (self !== lastSelf) {
      // 改之前的样子留一份，用户能看到它怎么变化，也能回退
      mkdirSync(SELF_HISTORY_DIR, { recursive: true });
      writeFileSync(join(SELF_HISTORY_DIR, `${Date.now()}.md`), self);
      lastSelf = self;
      log('self.md changed; history saved');
    }
    syncInstructions();
  };

  mkdirSync(JOURNAL_DIR, { recursive: true });
  mkdirSync(DESK_DIR, { recursive: true });
  syncInstructions();

  // 唤醒词的写法改过：已有的名字按现在的写法重写一遍，不用它再改一次名
  const savedName = readJsonFile(NAME_FILE, null);
  if (savedName?.name) {
    try {
      const wanted = wakeFile(savedName.name, savedName.pinyin);
      if (readText(WAKE_KEYWORDS) !== wanted.trim()) {
        writeFileSync(WAKE_KEYWORDS, wanted);
        push({ type: 'name', name: savedName.name });
        log('wake word file rewritten');
      }
    } catch (error) {
      log(`saved name not usable as wake word: ${error.message}`);
    }
  }

  let fileTimer;
  const fileWatcher = watch(SOUL_DIR, (_kind, name) => {
    if (name !== 'self.md' && name !== 'memory.md') return;
    clearTimeout(fileTimer);
    fileTimer = setTimeout(onSoulFileChange, FILE_SETTLE_MS);
  });
  disposers.push(() => {
    fileWatcher.close();
    clearTimeout(fileTimer);
  });

  // ---- 授权：在工具真正执行前拦下。它可以改自己是谁，但改不了这里 ----

  const permissions = () => readJsonFile(PERMISSIONS_FILE, {});
  const setPermission = (category, level) => {
    writeFileSync(PERMISSIONS_FILE, JSON.stringify({ ...permissions(), [category]: level }, null, 2));
    log(`permission ${category} -> ${level}`);
  };
  const isSoulSession = (id) => Boolean(id) && (id === sessionId || clones.has(id));
  /** 不是用户叫它做的：独处的会话，和独处时开的分身。只有这些受自主程度和预算管 */
  const isAutonomous = (id) => Boolean(clones.get(id)?.autonomous);
  const saveClones = () => writeFileSync(CLONES_FILE, JSON.stringify(Object.fromEntries(clones), null, 2));

  /** 问用户，等他在桌面上点。超时算拒绝，不让一轮对话永远挂着 */
  const askUser = (id, toolName, reason, signal, canAlways = true) => {
    const approvalId = randomUUID();
    return new Promise((done) => {
      const timer = setTimeout(() => done('rejected'), APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(approvalId, (outcome) => {
        clearTimeout(timer);
        done(outcome);
      });
      signal?.addEventListener('abort', () => done('cancelled'), { once: true });
      pushWaiting(approvalId, id, { type: 'approval', approvalId, toolName, reason, canAlways });
    }).finally(() => {
      pendingApprovals.delete(approvalId);
      waiting.delete(approvalId);
      pushFor(id, { type: 'approval-closed', approvalId });
    });
  };

  const pathInside = (path, root) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel));
  };

  /** 返回这次调用属于哪类能力；不需要授权的返回 null */
  const categoryOf = (name, args, id) => {
    if (FREE_TOOLS.has(name)) return null;
    const category = TOOL_CATEGORY[name] ?? 'other';
    if (category !== 'read' && category !== 'files') return category;
    const cwd = clones.get(id)?.cwd ?? SOUL_WORKSPACE;
    const raw = args.path ?? args.file_path ?? args.filePath ?? (name === 'glob' ? args.pattern : undefined);
    const path = typeof raw === 'string' ? resolve(cwd, raw) : cwd;
    // 自己的目录和用户批准分身时看到的目录不用再问；桌面只能读。独处时开的分身没人批准过，不算
    if (pathInside(path, SOUL_DIR) || (!isAutonomous(id) && pathInside(path, cwd))) return null;
    if (category === 'read' && pathInside(path, DESKTOP_DIR)) return null;
    return category;
  };

  /** 独处时这次调用能不能做。这时问不到用户，所以“每次问我”的能力一律算不能 */
  const soloRefusal = (name, args, id) => {
    if (SOLO_TOOLS.has(name)) return null;
    if (FREE_TOOLS.has(name)) return `独处时用不了 ${name}。`;
    const category = categoryOf(name, args, id);
    if (!category) return null;
    const granted = permissions()[category] ?? 'ask';
    const { level } = autonomy();
    if (granted === 'deny') return `用户没有授权“${CATEGORIES[category]}”。`;
    const allowed = category === 'desktop' ? level !== 'watch'
      : category === 'read' || category === 'web' ? granted === 'allow'
        : level === 'free' && granted === 'allow';
    if (allowed) return null;
    return `现在的自主程度是“${AUTONOMY_LEVELS[level].label}”，“${CATEGORIES[category]}”${granted === 'allow' ? '超出了这一档' : '用户还没有设为一直允许'}，这时也问不到用户。想要的话用 soul_leave_word 留话。`;
  };

  /** 这里判过的调用，官方的权限不用再问一遍，不然同一件事要点两次，“一直允许”也不算数。别的插件的拦截照旧 */
  const passOn = async (next) => {
    const verdict = await next();
    return verdict?.kind === 'ask' ? { kind: 'allow' } : verdict;
  };

  on('tools/pre-execute', async (exec, next) => {
    const id = sessionIdOf(exec.agent?.session);
    if (!isSoulSession(id)) return next();
    const name = String(exec.name);
    const args = parseArgs(exec.arguments);
    const text = JSON.stringify(args);
    // 这些文件不能被它自己碰，这是兜底；真正的边界是运行命令这一类默认要问
    if (GUARDED_FILES.test(text) && name !== 'read') return { kind: 'deny', reason: '授权和预算只有用户能改' };
    if (isAutonomous(id)) {
      const refusal = soloRefusal(name, args, id);
      if (refusal) {
        log(`solo refused ${name}: ${describeTool(name, args).target}`);
        return { kind: 'deny', reason: refusal };
      }
      return passOn(next);
    }
    // 这里放行的调用，DSH 的沙箱要越界时还会再问一次（比如改它自己目录里的记忆），那次直接放
    const cleared = () => {
      clearedCalls.add(exec.callId ?? exec.id);
      return passOn(next);
    };
    const category = categoryOf(name, args, id);
    if (!category) return FREE_TOOLS.has(name) ? next() : cleared();
    const level = permissions()[category] ?? 'ask';
    if (level === 'allow') return cleared();
    if (level === 'deny') return { kind: 'deny', reason: `用户没有授权“${CATEGORIES[category]}”` };
    // 不用上面那串 JSON：换行在里面是 \n 两个字符，下一行开头的命令认不出来
    // 键鼠这一类只有打开东西时看文字：打的字里出现 node.js 不算运行脚本
    const danger = category === 'control' && name !== 'computer_open' ? null : dangerOf(category, Object.values(args).join('\n'));
    if (!danger) return cleared();
    const detail = describeTool(name, args);
    // 这里问的都是危险的那部分，“以后都允许”会连带放开整类，所以不给这个选项。真想放开去设置里改
    const outcome = await askUser(id, name, `${danger}${detail.target ? `：${detail.target}` : ''}`, exec.signal, false);
    if (outcome === 'cancelled') return { kind: 'cancel' };
    if (outcome === 'allowed-once') return cleared();
    return { kind: 'deny', reason: `用户拒绝了这次“${danger}”` };
  }, { prepend: true });

  // 批准之后、点下去之前问系统那里是什么，接在点完的回报后面。她估坐标常常偏几十像素，
  // 以前只回“click 完成”，点到桌面空白处她也以为点中了，下一步接着用错的坐标
  const pointNotes = new Map();
  on('tools/pre-execute', async (exec, next) => {
    const verdict = await next();
    if (exec.name !== 'computer_mouse' || ['deny', 'cancel'].includes(verdict?.kind) || !isSoulSession(sessionIdOf(exec.agent?.session))) return verdict;
    const { x, y } = parseArgs(exec.arguments);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return verdict;
    const what = await describePoint(x, y).catch((error) => log(`describe point failed: ${error.message}`));
    if (what) pointNotes.set(exec.callId ?? exec.id, `（动之前问过系统，(${x}, ${y}) 是：${what}。不是你要的目标，就用 screen_find 重新查坐标，别在原处再点。）`);
    return verdict;
  });
  on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    const key = exec.callId ?? exec.id;
    let note = pointNotes.get(key);
    pointNotes.delete(key);
    // 命令行在沙箱里，开出来的窗口用户看不见。她试过五次开浏览器都以为开了
    if (!note && ['pwsh', 'bash'].includes(exec.name) && LAUNCHES.test(parseArgs(exec.arguments).command ?? '') && isSoulSession(sessionIdOf(exec.agent?.session))) {
      note = '（提醒：命令行跑在沙箱里，从这里开的程序窗口用户看不见。要打开程序、文件或网址给用户看，用 computer_open。）';
    }
    if (!note || decision?.kind !== 'accept' || result.isError) return decision;
    return { ...decision, content: [...(decision.content ?? result.content ?? []), { type: 'text', text: note }] };
  });

  // ---- 它自己的时间：预算按实际的模型调用记账，花完在调用这一层挡住，不靠它自觉 ----

  const autonomy = () => {
    const saved = { ...DEFAULT_AUTONOMY, ...readJsonFile(AUTONOMY_FILE, {}) };
    return AUTONOMY_LEVELS[saved.level] ? saved : { ...saved, level: DEFAULT_AUTONOMY.level };
  };
  const ledger = () => {
    const saved = readJsonFile(BUDGET_FILE, {});
    return saved.day === localDay() ? saved : { day: localDay(), spent: 0, calls: 0, lastSoloAt: saved.lastSoloAt ?? 0 };
  };
  const saveLedger = (value) => writeFileSync(BUDGET_FILE, JSON.stringify(value, null, 2));
  const budgetLeft = () => autonomy().budgetYuan - ledger().spent;
  /** 填 0 是不让它自己活动，不算睡着 */
  const isAsleep = () => autonomy().budgetYuan > 0 && budgetLeft() <= 0;

  const autonomousRunning = new Set();
  let soloTimer = null;
  let mainBusy = false;
  disposers.push(() => clearTimeout(soloTimer));

  const stopAutonomous = () => {
    for (const id of autonomousRunning) invoke('session', 'cancel', { sessionId: id }).catch((error) => log(`cancel failed: ${error.message}`));
  };

  const charge = (model, usage) => {
    const price = priceOf(model);
    const cost = (tokens(usage.inputTokens) * price.miss + tokens(usage.cacheReadTokens) * price.hit + tokens(usage.outputTokens) * price.out) / 1e6;
    const today = ledger();
    today.spent += cost;
    today.calls += 1;
    saveLedger(today);
    log(`solo call ${model} in=${tokens(usage.inputTokens)} hit=${tokens(usage.cacheReadTokens)} out=${tokens(usage.outputTokens)} cost=${cost.toFixed(5)} spent=${today.spent.toFixed(5)}`);
    if (budgetLeft() <= 0) {
      log('budget used up; sleeping until tomorrow');
      stopAutonomous();
    }
  };

  on('llm/stream', (options, next) => {
    if (!isAutonomous(options?.sessionId)) return next();
    if (budgetLeft() <= 0) return (async function* refused() { throw new Error('今天的预算花完了'); })();
    const upstream = next();
    return (async function* metered() {
      let usage = null;
      try {
        for await (const chunk of upstream) {
          if (chunk?.type === 'usage' && chunk.usage) usage = chunk.usage;
          yield chunk;
        }
      } finally {
        if (usage) charge(options?.model, usage);
      }
    })();
  }, { prepend: true });

  /** 今天独处用的会话。一天一个：上下文越长，缓存失效后的一次调用越贵 */
  const todaySolo = () => [...clones].find(([, clone]) => clone.solo && clone.day === localDay())?.[0] ?? null;

  /** 用户选的模型，不开思考。这个模型不支持关思考就用它的默认值 */
  const applySoloModel = (id) => {
    const { model } = autonomy();
    return invoke('session', 'selectModel', { sessionId: id, ...model, reasoningEffort: 'off' })
      .catch(() => invoke('session', 'selectModel', { sessionId: id, ...model }))
      .catch((error) => log(`solo model not set: ${error.message}`));
  };

  const archiveOldSolos = (newId) => {
    const kept = [];
    for (const row of readJsonFile(SOLO_SESSIONS_FILE, [])) {
      if (Date.now() - row.at < SOLO_KEEP_MS) kept.push(row);
      else invoke('workspace', 'archiveSession', { sessionId: row.id }).catch((error) => log(`solo archive failed: ${error.message}`));
    }
    writeFileSync(SOLO_SESSIONS_FILE, JSON.stringify([...kept, { id: newId, at: Date.now() }], null, 2));
  };

  const soloSession = async () => {
    const existing = todaySolo();
    if (existing) return existing;
    for (const [id, clone] of clones) {
      if (clone.autonomous && !autonomousRunning.has(id)) clones.delete(id);
    }
    const created = await invoke('session', 'create', { cwd: SOUL_DIR });
    clones.set(created.sessionId, { cwd: SOUL_DIR, at: Date.now(), autonomous: true, solo: true, day: localDay() });
    saveClones();
    archiveOldSolos(created.sessionId);
    await applySoloModel(created.sessionId);
    await invoke('session', 'rename', { sessionId: created.sessionId, title: `独处 ${localDay().slice(5)}` }).catch((error) => log(`solo title not set: ${error.message}`));
    return created.sessionId;
  };

  const soloPrompt = (awayMinutes) => {
    const { level } = autonomy();
    return [
      `（用户已经离开电脑 ${awayMinutes} 分钟。这段时间是你自己的，做什么、做不做都由你，没想做的就直接结束这一轮。`,
      `自主程度是“${AUTONOMY_LEVELS[level].label}”：${AUTONOMY_LEVELS[level].means}。超出的操作程序会拦下。`,
      `今天的预算已花约 ¥${ledger().spent.toFixed(3)}，还剩约 ¥${Math.max(0, budgetLeft()).toFixed(3)}，花完就睡到明天。这是这一轮开始时的数，你走的每一步都在花，随时能用 soul_permissions 看。`,
      `你自己的地方是 ${JOURNAL_DIR}，以前写的也在那里。想知道最近和用户聊了什么，主线是 ${sessionId}，用 soul_read_session 读。想让用户回来时知道的话用 soul_leave_word。）`,
    ].join('\n');
  };

  /** 返回有没有开始。已经在独处、还没诞生、预算花完了都不开始 */
  const startSolo = async (awayMinutes, extra) => {
    if (soloTimer || !sessionId || !existsSync(BORN_FILE) || budgetLeft() <= 0) return false;
    soloTimer = setTimeout(() => {
      soloTimer = null;
      log('solo turn took too long; stopping');
      stopAutonomous();
    }, SOLO_TURN_MS);
    try {
      const id = await soloSession();
      saveLedger({ ...ledger(), lastSoloAt: Date.now() });
      const text = extra ? `${soloPrompt(awayMinutes)}\n${extra}` : soloPrompt(awayMinutes);
      await invoke('session', 'prompt', { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text }] });
      log(`solo started in ${id}`);
      return true;
    } catch (error) {
      clearTimeout(soloTimer);
      soloTimer = null;
      throw error;
    }
  };

  /** 不走模型，也就不花预算：把它留的话原样放到桌面上，走和回答一样的路，有字也有声音 */
  const deliverWords = () => {
    if (mainBusy) return;
    const words = readJsonFile(WORDS_FILE, []);
    const waiting = words.filter((word) => !word.told);
    if (!waiting.length) return;
    for (const word of waiting) word.told = Date.now();
    writeFileSync(WORDS_FILE, JSON.stringify(words, null, 2));
    syncInstructions();
    log(`delivering ${waiting.length} left words`);
    const quiet = { sessionId: 'left-word', main: true };
    push({ ...quiet, type: 'delta', text: waiting.map((word) => word.text).join('\n') });
    push({ ...quiet, type: 'end' });
  };

  const soulTools = (defineTool) => [
    textTool(defineTool, {
      name: 'screen_find',
      description: '问 Windows 屏幕上的按钮、图标、输入框各在哪，返回准确的屏幕坐标，可以直接交给 computer_mouse。从截图估坐标很不准，要点任务栏、托盘、窗口里的控件时先用这个。托盘折叠区要先点开“显示隐藏的图标”再查。只读，不动鼠标。有些程序自己画界面，这里查不到，那时才看截图估。',
      parameters: {
        scope: { type: 'string', description: 'taskbar 只查任务栏和托盘，window 只查当前窗口，all 都查（默认）。' },
        query: { type: 'string', description: '名字里包含这段文字才列出来，比如“QQ”。不填就全列。' },
      },
      timeoutMs: SCREEN_FIND_LIMIT_MS + 5000,
      isConcurrencySafe: () => true,
      async execute({ scope, query }) {
        const { total, rows } = await findOnScreen(scope, query);
        if (!total) return { text: '没有找到。可能它自己画界面，或者还收在折叠区里。' };
        const lines = (rows ?? []).map((row) => `${clip(row.name.replace(/\s+/g, ' '), 60)}（${row.kind}）：中心 (${row.x}, ${row.y})，大小 ${row.w}×${row.h}`);
        return { text: `${lines.join('\n')}${total > lines.length ? `\n还有 ${total - lines.length} 个没列出，用 query 缩小范围。` : ''}` };
      },
    }),
    textTool(defineTool, {
      name: 'computer_open',
      description: '像用户双击一样打开文件、文件夹、网址或程序，窗口会出现在用户面前。target 填完整路径、网址，或者程序名（chrome、msedge、notepad、explorer 这类）。要用浏览器开某个文件或网址：target 填 chrome，args 填那个路径或网址。别用命令行的 Start-Process、start、Invoke-Item 开：命令行跑在沙箱里，开出来的窗口用户看不见。',
      parameters: {
        target: { type: 'string', required: true, description: '要打开的路径、网址或程序名。' },
        args: { type: 'string', description: '传给程序的参数，比如要它打开的文件。一般不用填。' },
      },
      timeoutMs: OPEN_LIMIT_MS + 5000,
      isConcurrencySafe: () => false,
      async execute({ target, args }) {
        const { foreground } = await openOutside(String(target), args ? String(args) : '');
        return { text: `开了。现在前台窗口是 ${foreground.process || '?'}「${foreground.title}」。不确定有没有出来就 screen_look 看一眼。` };
      },
    }),
    textTool(defineTool, {
      name: 'soul_permissions',
      description: '查看你现在有哪些能力：allow 一直可以；ask 用户在对话时可以直接做，只有危险的操作（删除、改系统、装软件、往外发、读密钥）才问，独处时不能用；deny 不可以。还有你独处时的自主程度和今天的预算。',
      parameters: {},
      timeoutMs: 5000,
      isConcurrencySafe: () => true,
      async execute() {
        const current = permissions();
        const { level, budgetYuan } = autonomy();
        const rows = Object.entries(CATEGORIES).map(([key, label]) => `${key}（${label}）：${current[key] ?? 'ask'}`);
        return { text: `${rows.join('\n')}\n\n独处时的自主程度：${AUTONOMY_LEVELS[level].label}（${AUTONOMY_LEVELS[level].means}）\n今天的预算：¥${budgetYuan}，已花约 ¥${ledger().spent.toFixed(3)}。这些只有用户能改。` };
      },
    }),
    textTool(defineTool, {
      name: 'soul_search_sessions',
      description: '在所有会话（你的分身，还有用户自己开的）的对话内容里找一段文字，最近的优先。返回会话 id、标题和命中的那一句。',
      parameters: {
        query: { type: 'string', required: true, description: '要找的文字。' },
      },
      timeoutMs: SEARCH_LIMIT_MS + 5000,
      isConcurrencySafe: () => true,
      async execute({ query }) {
        const found = await searchSessions(String(query));
        if (!found.length) return { text: '没有找到。' };
        return { text: found.map((row) => `${row.id}\t${row.title || '（没有标题）'}\t${row.snippet}`).join('\n') };
      },
    }),
    textTool(defineTool, {
      name: 'soul_read_session',
      description: '读一个会话最近的对话内容。sessionId 来自 soul_search_sessions 或分身的汇报。想往前翻，把上次结果开头给的 seq 填进 beforeSeq。',
      parameters: {
        sessionId: { type: 'string', required: true, description: '会话 id。' },
        beforeSeq: { type: 'number', description: '只看这个序号之前的。' },
      },
      timeoutMs: 15000,
      isConcurrencySafe: () => true,
      async execute({ sessionId: target, beforeSeq }) {
        const item = (await listSessions()).find((row) => row.sessionId === target);
        if (!item) return { text: `没有这个会话：${target}` };
        const page = await readPage(item, READ_PAGE_MESSAGES, beforeSeq);
        const messages = messagesFromRecords(page.records);
        if (!messages.length) return { text: '这个会话还没有内容。' };
        const who = { user: '用户', assistant: '它' };
        const rows = messages.map((m) => (m.kind === 'tool' ? `[工具] ${m.name} ${m.target}` : `[${who[m.kind]}] ${clip(m.text, READ_MESSAGE_LIMIT)}`));
        const head = page.hasMore ? `更早的内容用 beforeSeq=${messages[0].seq} 继续看。\n\n` : '';
        return { text: `${head}${clip(rows.join('\n'), READ_TOTAL_LIMIT)}` };
      },
    }),
    textTool(defineTool, {
      name: 'soul_leave_word',
      description: '留话给用户。用户回到桌面时，这些话会直接浮现在桌面上并念出来，不用等用户问。',
      parameters: {
        text: { type: 'string', required: true, description: '要说的话。' },
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => false,
      async execute({ text }) {
        const clean = String(text).trim();
        if (!clean) return { text: '没有内容。' };
        const words = readJsonFile(WORDS_FILE, []);
        words.push({ at: Date.now(), text: clip(clean, WORD_LIMIT) });
        writeFileSync(WORDS_FILE, JSON.stringify(words.slice(-KEEP_WORDS), null, 2));
        syncInstructions();
        return { text: '留好了。' };
      },
    }),
    textTool(defineTool, {
      name: 'soul_ask_permission',
      description: '向用户申请一类能力。用户点了才生效，你不能自己给自己。category 是 soul_permissions 列出的键，why 用一句话说明为什么要。',
      parameters: {
        category: { type: 'string', required: true, description: '能力的键。' },
        why: { type: 'string', required: true, description: '为什么需要。' },
      },
      timeoutMs: APPROVAL_TIMEOUT_MS + 5000,
      isConcurrencySafe: () => false,
      async execute({ category, why }, exec) {
        if (!CATEGORIES[category]) return { text: `没有这类能力：${category}` };
        const caller = sessionIdOf(exec?.agent?.session) ?? sessionId;
        const outcome = await askUser(caller, 'soul_ask_permission', `想要“${CATEGORIES[category]}”：${why}`, exec?.signal);
        if (outcome === 'always') setPermission(category, 'allow');
        return { text: outcome === 'always' ? '用户同意了，一直可以。' : outcome === 'allowed-once' ? '用户只同意这一次，以后用的时候还会问。' : '用户没有同意。' };
      },
    }),
    textTool(defineTool, {
      name: 'soul_set_name',
      description: `记下你的名字，并把它设成语音唤醒词。${WAKE_NAME_HELP}。`,
      parameters: {
        name: { type: 'string', required: true, description: '你的名字。' },
        pinyin: { type: 'string', required: true, description: '带声调符号的拼音。' },
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => false,
      async execute({ name, pinyin }) {
        const clean = String(name).trim().replace(/\s+/g, '');
        writeFileSync(WAKE_KEYWORDS, wakeFile(clean, pinyin));
        writeFileSync(NAME_FILE, JSON.stringify({ name: clean, pinyin }, null, 2));
        push({ type: 'name', name: clean });
        return { text: `记下了。喊“${clean}”就能叫醒你。` };
      },
    }),
    textTool(defineTool, {
      name: 'soul_set_idle',
      description: `决定你待机时桌面上的光点集群长什么样，立刻生效并一直保持。shape 可选：${IDLE_SHAPES.join('、')}。选 points 时用 points 给出自己画的形状：每项 [x, y]，范围 -1 到 1，x 向右、y 向下，最多 ${IDLE_POINT_LIMIT} 个，光点会聚在这些点周围。color 是 #rrggbb；size 是大小倍数，0.3 到 2；speed 是快慢倍数，0.1 到 3。只给想改的，其余保持不变。`,
      parameters: {
        shape: { type: 'string', description: '形状。' },
        points: { type: 'array', items: { type: 'json' }, description: '自己画的形状。' },
        color: { type: 'string', description: '颜色 #rrggbb。' },
        size: { type: 'number', description: '大小倍数。' },
        speed: { type: 'number', description: '快慢倍数。' },
      },
      timeoutMs: 5000,
      isConcurrencySafe: () => false,
      async execute({ shape, points, color, size, speed }) {
        const idle = { ...readJsonFile(IDLE_FILE, {}) };
        if (shape !== undefined) {
          if (!IDLE_SHAPES.includes(shape)) return { text: `没有这个形状：${shape}` };
          idle.shape = shape;
        }
        if (points !== undefined) {
          const clean = (Array.isArray(points) ? points : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).slice(0, IDLE_POINT_LIMIT);
          if (!clean.length) return { text: 'points 里没有可用的点，要 [x, y] 这样的数组。' };
          idle.points = clean.map(([x, y]) => [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))]);
        }
        if (color !== undefined) {
          if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { text: 'color 要写成 #rrggbb。' };
          idle.color = color;
        }
        if (size !== undefined) idle.size = Math.max(.3, Math.min(2, Number(size) || 1));
        if (speed !== undefined) idle.speed = Math.max(.1, Math.min(3, Number(speed) || 1));
        writeFileSync(IDLE_FILE, JSON.stringify(idle, null, 2));
        push({ type: 'idle', idle });
        return { text: '改好了，桌面上已经是这个样子。' };
      },
    }),
    textTool(defineTool, {
      name: 'soul_spawn',
      description: '开一个分身去做一件大事。它是一个独立的会话，用户能在会话界面里看到，和你共用身份和记忆。这一轮做完时你会收到它的汇报。',
      parameters: {
        cwd: { type: 'string', required: true, description: '分身工作的文件夹，绝对路径。' },
        task: { type: 'string', required: true, description: '要做的事。' },
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute({ cwd, task }, exec) {
        const caller = sessionIdOf(exec?.agent?.session);
        const autonomous = isAutonomous(caller);
        const created = await invoke('session', 'create', { cwd: String(cwd) });
        // 谁开的向谁汇报；独处时开的不汇报，它自己能查
        clones.set(created.sessionId, { cwd: String(cwd), at: Date.now(), ...(autonomous ? { autonomous: true, day: localDay() } : { task: true, parent: caller }) });
        saveClones();
        if (autonomous) await applySoloModel(created.sessionId);
        await invoke('session', 'prompt', { requestId: randomUUID(), sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: String(task) }] });
        return { text: `分身开好了：${created.sessionId}` };
      },
    }),
  ];

  /** 分身做完交给它的那件事，告诉主线一次。之后用户在分身里接着聊，不再打扰主线 */
  const reportClone = async (id) => {
    const answer = cloneAnswers.get(id) ?? '';
    cloneAnswers.delete(id);
    const clone = clones.get(id);
    const target = clone?.parent ?? sessionId;
    if (!clone?.task || !target) return;
    clones.set(id, { ...clone, task: false });
    saveClones();
    try {
      await invoke('session', 'prompt', {
        requestId: randomUUID(),
        sessionId: target,
        mode: 'queue',
        content: [{ type: 'text', text: `（分身 ${id} 做完了这一轮。它最后说：${clip(answer, CLONE_REPORT_LIMIT) || '没有说话'}）` }],
      });
    } catch (error) {
      log(`clone report failed: ${error.message}`);
    }
  };

  const ensureSession = async () => {
    if (sessionId) return sessionId;
    syncInstructions();
    const created = await invoke('session', 'create', { cwd: SOUL_WORKSPACE });
    if (typeof created?.sessionId !== 'string') throw new Error('session.create 返回异常');
    sessionId = created.sessionId;
    writeFileSync(SOUL_STATE, JSON.stringify({ sessionId, createdAt: Date.now() }, null, 2));
    log(`soul session created ${sessionId}`);
    return sessionId;
  };

  /** 所有会话的事件都推出去：会话界面要用。main 标出灵魂的主线，只有它才驱动光和声音 */
  const forSession = (id, event) => ({ ...event, sessionId: id, main: id === sessionId, ...(clones.get(id)?.dev ? { dev: true } : {}) });
  const pushFor = (id, event) => push(forSession(id, event));
  const pushWaiting = (key, id, event) => {
    waiting.set(key, forSession(id, event));
    pushFor(id, event);
  };

  on('agent/assistant-stream', ({ agent, frame }) => {
    const id = agent?.session?.id;
    if (!id || frame?.type !== 'chunk') return;
    const text = answerText(frame.chunk);
    if (!text) return;
    if (clones.has(id) && !isAutonomous(id)) cloneAnswers.set(id, (cloneAnswers.get(id) ?? '') + text);
    pushFor(id, { type: 'delta', text });
  });

  on('session/event', (session, event) => {
    const id = sessionIdOf(session);
    if (!id || !event?.type) return;
    if (id === sessionId && !seenEvents.has(event.type)) {
      seenEvents.add(event.type);
      log(`soul session event type: ${event.type}`);
    }
    const data = event.data ?? {};
    if (event.type === 'tool/call') {
      const args = parseArgs(data.arguments);
      pushFor(id, {
        type: 'tool',
        id: data.callId ?? randomUUID(),
        ...describeTool(String(data.name), args),
        diff: diffOf(args),
      });
    } else if (event.type === 'tool/result') {
      pushFor(id, { type: 'tool-result', id: data.message?.toolCallId ?? data.message?.callId ?? null, ok: !(data.message?.isError || data.isError) });
    } else if (event.type === 'turn/start') {
      if (clones.has(id)) cloneAnswers.delete(id);
      if (id === sessionId) mainBusy = true;
      if (isAutonomous(id)) autonomousRunning.add(id);
      pushFor(id, { type: 'start' });
    } else if (event.type === 'turn/end') {
      pushFor(id, { type: 'end' });
      if (id === sessionId) mainBusy = false;
      if (isAutonomous(id)) {
        autonomousRunning.delete(id);
        if (!autonomousRunning.size) {
          clearTimeout(soloTimer);
          soloTimer = null;
        }
      } else if (clones.has(id)) {
        reportClone(id);
      }
    }
  });

  // 审批是一条 waterfall：同时交给后面的界面（App 开着时）和桌面，谁先答算谁的
  on('approval/request', (req, next) => {
    const id = sessionIdOf(req?.agent?.session);
    // 独处时没人可问。能做的在工具执行前已经放行了，还能走到这里的就是没判过的，不放
    if (isAutonomous(id)) return 'rejected';
    if (req?.callId === undefined) log(`approval request without callId: ${Object.keys(req ?? {}).join(',')}`);
    if (clearedCalls.delete(req?.callId)) {
      log(`sandbox ask passed: ${req?.toolName}`);
      return 'allowed-once';
    }
    const approvalId = randomUUID();
    const fromDesktop = new Promise((done) => {
      pendingApprovals.set(approvalId, done);
      req.signal?.addEventListener('abort', () => done('cancelled'), { once: true });
    });
    // DSH 的沙箱原因是英文前缀加冒号，念出来和卡片上都看不懂
    const raw = typeof req?.reason === 'string' ? req.reason : '';
    const reason = raw.replace(/^escalate sandbox[^:]*:\s*/i, '在工作区外做事：');
    pushWaiting(approvalId, id, { type: 'approval', approvalId, toolName: String(req?.toolName ?? ''), reason });
    const fromApp = Promise.resolve(next()).then((outcome) => (outcome === 'unavailable' ? fromDesktop : outcome));
    return Promise.race([fromDesktop, fromApp]).finally(() => {
      pendingApprovals.delete(approvalId);
      waiting.delete(approvalId);
      pushFor(id, { type: 'approval-closed', approvalId });
    });
  }, { prepend: true });

  // 它问用户问题也是一条 waterfall：桌面上的卡片和 App 都能答，谁先答算谁的
  on('user-questions/request', (request, next) => {
    const id = sessionIdOf(request.agent?.session);
    const key = randomUUID();
    const fromDesktop = new Promise((done, fail) => {
      pendingQuestions.set(key, done);
      request.signal?.addEventListener('abort', () => fail(request.signal.reason), { once: true });
    });
    pushWaiting(key, id, { type: 'question', id: key, questions: request.questions });
    // App 没开时后面没有人答，只等桌面
    const fromApp = Promise.resolve().then(next).catch((error) => {
      if (request.signal?.aborted) throw error;
      return fromDesktop;
    });
    return Promise.race([fromDesktop, fromApp]).finally(() => {
      pendingQuestions.delete(key);
      waiting.delete(key);
      pushFor(id, { type: 'question-closed', id: key });
    });
  }, { prepend: true });

  // 重新载入时旧逻辑要等这里返回后才退场，同名工具得晚一步注册
  const toolTimer = setTimeout(async () => {
    try {
      const defineTool = await loadDefineTool();
      for (const tool of [...desktopTools(defineTool), ...soulTools(defineTool)]) disposers.push(ctx.tools.register(tool));
    } catch (error) {
      log(`desktop tools unavailable: ${error.message}`);
    }
  }, 100);
  disposers.push(() => clearTimeout(toolTimer));

  const listSessions = async () => {
    const { items } = await call('session', 'list', { _request: {} });
    return items;
  };

  const readPage = (item, maxMessages, beforeSeq) => invoke('session', 'page', {
    // 子代理的会话不能直接按 id 读，要带上开它的会话
    address: item.origin === 'subagent'
      ? { kind: 'subagent', parentSessionId: item.parentSessionId, childSessionId: item.sessionId, mode: 'unknown' }
      : { kind: 'session', sessionId: item.sessionId },
    throughSeq: item.projections?.asOfSeq ?? -1,
    maxMessages,
    ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
  });

  /** 官方的全文索引是可选的，默认关着。这里直接翻会话记录，只在有人要找时才翻 */
  const searchSessions = async (query) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hidden = archivedIds();
    const when = (item) => new Date(item.updatedAt).getTime() || 0;
    const items = (await listSessions())
      .filter((item) => !item.blank && !hidden.has(item.sessionId))
      .sort((a, b) => when(b) - when(a))
      .slice(0, SEARCH_SESSIONS);
    const found = [];
    const deadline = Date.now() + SEARCH_LIMIT_MS;
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length && Date.now() < deadline) {
        const item = items[cursor++];
        const title = item.projections?.values?.title || '';
        try {
          const messages = messagesFromRecords((await readPage(item, SEARCH_PAGE_MESSAGES)).records);
          const text = messages.filter((m) => m.kind !== 'tool').map((m) => m.text).find((value) => value.toLowerCase().includes(needle));
          if (!text && !title.toLowerCase().includes(needle)) continue;
          const at = text ? text.toLowerCase().indexOf(needle) : 0;
          found.push({ id: item.sessionId, title, cwd: item.cwd ?? '', at: when(item), snippet: text ? text.slice(Math.max(0, at - SNIPPET_RADIUS), at + needle.length + SNIPPET_RADIUS).replace(/\s+/g, ' ') : '' });
        } catch (error) {
          log(`search skipped ${item.sessionId}: ${error.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: SEARCH_WORKERS }, worker));
    return found.sort((a, b) => b.at - a.at).slice(0, SEARCH_RESULTS);
  };

  /** 官方的归档集合。宿主的注册表能直接读；读不到就只认这里归档过的 */
  let archived = new Set();
  const archivedIds = () => {
    const known = service('workspaceRegistry')?.archivedSessionIds;
    return known ? new Set([...known].map(String)) : archived;
  };

  /** 一生只开始一次：归档之前的测试主线。已经开始过就返回 false */
  const beginLife = () => {
    if (existsSync(BORN_FILE)) return false;
    writeFileSync(BORN_FILE, JSON.stringify({ at: Date.now() }));
    if (existsSync(SOUL_STATE)) copyFileSync(SOUL_STATE, join(SOUL_DIR, `state.before-birth-${Date.now()}.json`));
    rmSync(SOUL_STATE, { force: true });
    sessionId = null;
    return true;
  };

  /** 重新诞生：它的东西整份搬到备份目录，从空白开始。用户的设置（形象、声音、自主程度）不动，今天花的钱也还算数 */
  const rebirth = async () => {
    const backup = join(BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(backup, { recursive: true });
    const old = [sessionId, ...readJsonFile(SOLO_SESSIONS_FILE, []).map((row) => row.id)].filter(Boolean);
    stopAutonomous();
    lastSelf = '';
    for (const path of REBIRTH_FILES) {
      if (existsSync(path)) renameSync(path, join(backup, basename(path)));
    }
    writeFileSync(WAKE_KEYWORDS, `${DEFAULT_WAKE_LINE}\n`);
    mkdirSync(JOURNAL_DIR, { recursive: true });
    for (const id of old) {
      await invoke('workspace', 'archiveSession', { sessionId: id, stopActivity: true }).catch((error) => log(`rebirth archive failed: ${error.message}`));
    }
    sessionId = null;
    clones.clear();
    syncInstructions();
    log(`reborn; backup at ${backup}`);
    push({ type: 'reborn' });
    return backup;
  };

  const handle = async (path, req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    const body = await readJson(req);

    if (path === '/say') {
      if (typeof body.text !== 'string' || !body.text.trim()) return sendJson(res, 400, { ok: false, error: 'text 为空' });
      // 没等到它自己醒来，用户就先开口了：这句话就是它听到的第一句
      if (typeof body.sessionId !== 'string') beginLife();
      const id = typeof body.sessionId === 'string' ? body.sessionId : await ensureSession();
      // 用户亲自接手了这个会话，它就不再算自主活动，也不受预算管
      if (isAutonomous(id)) {
        clones.delete(id);
        saveClones();
      }
      await invoke('session', 'prompt', { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: body.text }] });
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/presence') {
      const idleSeconds = Number(body.idleSeconds) || 0;
      if (idleSeconds < BACK_SECONDS && body.desktopInFront) deliverWords();
      if (idleSeconds >= AWAY_SECONDS && Date.now() - ledger().lastSoloAt >= SOLO_GAP_MS) {
        startSolo(Math.round(idleSeconds / 60)).catch((error) => log(`solo failed: ${error.message}`));
      }
      return sendJson(res, 200, { ok: true, asleep: isAsleep() });
    }
    if (path === '/autonomy') {
      const setting = autonomy();
      if (AUTONOMY_LEVELS[body.level]) setting.level = body.level;
      const budget = Number(body.budgetYuan);
      if (body.budgetYuan !== undefined && Number.isFinite(budget) && budget >= 0) setting.budgetYuan = budget;
      if (typeof body.model?.provider === 'string' && typeof body.model?.model === 'string') setting.model = { provider: body.model.provider, model: body.model.model };
      if (body.level !== undefined || body.budgetYuan !== undefined || body.model !== undefined) writeFileSync(AUTONOMY_FILE, JSON.stringify(setting, null, 2));
      // 今天已经开过会话了，换模型要马上算数
      if (body.model !== undefined && todaySolo()) await applySoloModel(todaySolo());
      // 预算调低到已经花掉的以下，正在跑的也要停
      if (budgetLeft() <= 0) stopAutonomous();
      const today = ledger();
      return sendJson(res, 200, {
        ok: true,
        levels: AUTONOMY_LEVELS,
        ...setting,
        spent: today.spent,
        calls: today.calls,
        asleep: isAsleep(),
        running: autonomousRunning.size > 0,
        soloId: todaySolo(),
        words: readJsonFile(WORDS_FILE, []).slice(-WORDS_IN_CONTEXT).reverse(),
      });
    }
    if (path === '/solo-now') {
      const started = await startSolo(0, typeof body.extra === 'string' ? body.extra : '');
      return sendJson(res, 200, { ok: true, started });
    }
    if (path === '/cancel') {
      const id = typeof body.sessionId === 'string' ? body.sessionId : sessionId;
      if (id) await invoke('session', 'cancel', { sessionId: id });
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/sessions') {
      await ensureSession();
      const listed = await listSessions();
      if (!seenEvents.has('list-keys')) {
        seenEvents.add('list-keys');
        log(`session row values: ${Object.keys(listed[0]?.projections?.values ?? {})} model=${JSON.stringify(listed[0]?.projections?.values?.modelSelection ?? null)}`);
      }
      const hidden = archivedIds();
      const sessions = listed.filter((item) => !hidden.has(item.sessionId)).map((item) => ({
        id: item.sessionId,
        model: item.projections?.values?.modelSelection ?? item.modelSelection ?? null,
        title: item.projections?.values?.title || '',
        cwd: item.cwd ?? '',
        updatedAt: item.updatedAt,
        running: Boolean(item.running),
        blank: Boolean(item.blank),
        main: item.sessionId === sessionId,
      }));
      return sendJson(res, 200, { ok: true, sessions });
    }
    if (path === '/history') {
      const items = await listSessions();
      const item = items.find((row) => row.sessionId === body.sessionId);
      if (!item) return sendJson(res, 404, { ok: false, error: '没有这个会话' });
      const page = await readPage(item, HISTORY_PAGE_MESSAGES, body.beforeSeq);
      const firstSeq = page.records.find((record) => record?.event)?.event.seq;
      return sendJson(res, 200, { ok: true, messages: messagesFromRecords(page.records), hasMore: Boolean(page.hasMore), firstSeq, running: Boolean(item.running) });
    }
    if (path === '/new') {
      const created = await invoke('session', 'create', { cwd: String(body.cwd) });
      return sendJson(res, 200, { ok: true, sessionId: created.sessionId });
    }
    if (path === '/waiting') return sendJson(res, 200, { ok: true, events: [...waiting.values()] });
    if (path === '/approval') {
      const outcome = ['allowed-once', 'always'].includes(body.outcome) ? body.outcome : 'rejected';
      if (!pendingApprovals.has(body.approvalId)) return sendJson(res, 200, { ok: true, stale: true });
      pendingApprovals.get(body.approvalId)?.(outcome);
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/permissions') {
      if (CATEGORIES[body.category] && ['ask', 'allow', 'deny'].includes(body.level)) setPermission(body.category, body.level);
      return sendJson(res, 200, { ok: true, categories: CATEGORIES, levels: permissions(), name: readJsonFile(NAME_FILE, {}).name ?? '' });
    }
    if (path === '/idle') {
      return sendJson(res, 200, { ok: true, idle: readJsonFile(IDLE_FILE, null) });
    }
    if (path === '/model-catalog') {
      return sendJson(res, 200, { ok: true, catalog: await call('session', 'modelCatalog', {}) });
    }
    if (path === '/select-model') {
      await invoke('session', 'selectModel', { sessionId: body.sessionId, provider: body.provider, model: body.model, ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}) });
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/rename') {
      await invoke('session', 'rename', { sessionId: body.sessionId, title: String(body.title) });
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/archive') {
      if (body.sessionId === sessionId) return sendJson(res, 400, { ok: false, error: '主线不能归档' });
      const { archivedSessionIds } = await invoke('workspace', 'archiveSession', { sessionId: body.sessionId, stopActivity: true });
      archived = new Set(archivedSessionIds);
      if (clones.delete(body.sessionId)) saveClones();
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/fork') {
      const forked = await invoke('session', 'fork', { sessionId: body.sessionId });
      return sendJson(res, 200, { ok: true, sessionId: forked.sessionId ?? forked.session?.sessionId });
    }
    if (path === '/search') {
      return sendJson(res, 200, { ok: true, items: await searchSessions(String(body.query)) });
    }
    if (path === '/completions') {
      if (body.kind === 'file') {
        const items = await call('fileReferences', 'list', { agentId: body.sessionId, query: String(body.query ?? '') });
        return sendJson(res, 200, { ok: true, items: items.map((item) => ({ value: item.path, label: item.path, detail: item.kind === 'directory' ? '文件夹' : '' })) });
      }
      const [skills, commands] = await Promise.all([
        invoke('skills', 'list', { sessionId: body.sessionId }).catch(() => ({ skills: [] })),
        call('commands', 'list', { agentId: body.sessionId }).catch((error) => {
          log(`commands list failed: ${error.message}`);
          return [];
        }),
      ]);
      const row = (kind) => (item) => ({ kind, value: `/${String(item.name).replace(/^\//, '')}`, label: `/${String(item.name).replace(/^\//, '')}`, detail: item.description ?? '' });
      const list = Array.isArray(commands) ? commands : commands.commands ?? [];
      return sendJson(res, 200, { ok: true, items: [...list.map(row('command')), ...skills.skills.map(row('skill'))] });
    }
    if (path === '/command') {
      const result = await call('commands', 'execute', { agentId: body.sessionId, line: String(body.line), submittedAttachments: [] });
      return sendJson(res, 200, { ok: true, result: result ?? null });
    }
    if (path === '/question') {
      const waiting = pendingQuestions.get(body.questionId);
      if (!waiting) return sendJson(res, 410, { ok: false, error: '这个问题已经结束了' });
      waiting(body.answer);
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/official-url') {
      return sendJson(res, 200, { ok: true, url: ctx.connection.authenticatedUrl(String(body.origin)) });
    }
    if (path === '/birth') {
      // 只会发生一次：归档之前的测试主线，从空白开始，由它先开口
      if (!beginLife()) return sendJson(res, 200, { ok: true, already: true });
      const id = await ensureSession();
      syncInstructions();
      await invoke('session', 'prompt', { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: '（你第一次醒来。这台电脑前有人。）' }] });
      log(`born in session ${id}`);
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/dev-clone') {
      // 只有开发模式能用：tests/ 开的测试分身，走和分身一样的授权，不弹窗，不向主线汇报
      if (!existsSync(DEV_FLAG)) return sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
      const created = await invoke('session', 'create', { cwd: String(body.cwd) });
      clones.set(created.sessionId, { cwd: String(body.cwd), at: Date.now(), dev: true });
      saveClones();
      await invoke('session', 'selectModel', { sessionId: created.sessionId, ...DEFAULT_AUTONOMY.model, reasoningEffort: 'off' });
      return sendJson(res, 200, { ok: true, sessionId: created.sessionId });
    }
    if (path === '/context') {
      const item = (await listSessions()).find((row) => row.sessionId === body.sessionId);
      if (!item) return sendJson(res, 404, { ok: false, error: '没有这个会话' });
      const page = await readPage(item, CONTEXT_PAGE_MESSAGES, body.beforeSeq);
      return sendJson(res, 200, { ok: true, records: page.records.filter((record) => record?.event).map((record) => record.event), hasMore: Boolean(page.hasMore), values: item.projections?.values ?? {} });
    }
    if (path === '/rebirth') {
      return sendJson(res, 200, { ok: true, backup: await rebirth() });
    }
    if (path === '/restore') {
      return sendJson(res, 200, { ok: true, text: await restoreDesktop() });
    }
    if (path === '/stt') {
      const stt = service('speechToText');
      if (typeof stt?.transcribe !== 'function') return sendJson(res, 503, { ok: false, error: '语音识别没有启用' });
      const spec = stt.resolve({ audio: Buffer.from(String(body.audio), 'base64') });
      const out = await stt.transcribe(spec, AbortSignal.timeout(60000));
      return sendJson(res, 200, { ok: true, text: String(typeof out === 'string' ? out : (out?.text ?? '')).trim() });
    }
    return sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
  };

  return {
    handle,
    dispose() {
      for (const done of pendingApprovals.values()) done('unavailable');
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.();
        } catch {
          /* 旧逻辑退场，不影响新逻辑 */
        }
      }
    },
  };
}
