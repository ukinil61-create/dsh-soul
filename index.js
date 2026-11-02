/**
 * dsh-desk —— 宿主半侧的固定外壳
 *
 * 宿主只在启动时加载插件，所以这里尽量不改，真正的逻辑放在 host/soul.js：
 * 文件一变就重新载入，不用重启 DeepSeek Harness。
 *
 * 这里只做三件事：拉起桌面外壳、守住 /soul 路由的令牌、维持推送连接。
 * 令牌每次启动随机生成，只经环境变量递给外壳，不落盘、不进日志。
 * 自定义请求头也挡住了网页的跨站请求。
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'dsh-desk';
export const inject = ['webServer', 'connection', 'tools'];

const ROOT = dirname(fileURLToPath(import.meta.url));
const SHELL_MAIN = join(ROOT, 'shell', 'main.cjs');
const CORE_FILE = join(ROOT, 'host', 'soul.js');
const ELECTRON = join(homedir(), '.dsh', 'electron', 'electron.exe');
const STATE_DIR = join(homedir(), '.dsh', 'desk');
/** 托盘「退出」留下的标记：有它就不拉外壳，keeper 也不保活 App */
const PAUSED_FLAG = join(STATE_DIR, 'paused');
const LOG = join(STATE_DIR, 'host.log');
const ROUTE_PREFIX = '/soul';

const MIN_RESTART_MS = 2000;
const MAX_RESTART_MS = 60000;
/** 外壳活过这么久才算稳定，退避清零 */
const STABLE_MS = 60000;
const POLL_MS = 3000;
const SSE_PING_MS = 25000;
const RELOAD_DEBOUNCE_MS = 400;

function log(line) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志写不了不影响灵魂 */
  }
}

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

export function apply(ctx) {
  mkdirSync(STATE_DIR, { recursive: true });

  const token = randomBytes(24).toString('hex');
  const clients = new Set();
  const push = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      if (!res.destroyed && !res.writableEnded) res.write(line);
    }
  };

  let core;
  let disposed = false;
  let reloadTimer;

  const loadCore = async () => {
    try {
      const url = `${pathToFileURL(CORE_FILE).href}?v=${statSync(CORE_FILE).mtimeMs}`;
      const { createSoul } = await import(url);
      const next = await createSoul({ ctx, push, log });
      if (disposed) { next.dispose(); return; }
      core?.dispose();
      core = next;
      log('soul core loaded');
    } catch (error) {
      // 新代码有错就继续用旧的
      log(`soul core load failed: ${error.stack || error.message}`);
    }
  };

  const watcher = watch(dirname(CORE_FILE), () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadCore, RELOAD_DEBOUNCE_MS);
  });
  loadCore();

  const handler = async (req, res) => {
    if (req.headers['x-soul-token'] !== token) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname.slice(ROUTE_PREFIX.length) || '/';
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      res.write(': connected\n\n');
      const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
      clients.add(res);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return undefined;
    }
    try {
      if (!core) return sendJson(res, 503, { ok: false, error: '灵魂还没准备好' });
      return await core.handle(path, req, res);
    } catch (error) {
      log(`soul route ${path} failed: ${error.message}`);
      if (res.headersSent) return res.end();
      return sendJson(res, 500, { ok: false, error: error.message });
    }
  };
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'dsh-desk: /soul routes');

  let child;
  let retryTimer;
  let delay = MIN_RESTART_MS;
  let startedAt = 0;

  const launch = () => {
    if (disposed || child || existsSync(PAUSED_FLAG)) return;
    if (!existsSync(ELECTRON)) {
      log(`electron missing: ${ELECTRON}`);
      return;
    }
    // webServer 可能还没监听完，port 短暂为 0：下一次轮询再试
    const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
    if (!port) return;

    const env = { ...process.env, DSH_DESK_ORIGIN: `http://127.0.0.1:${port}`, DSH_DESK_TOKEN: token };
    delete env.ELECTRON_RUN_AS_NODE;

    startedAt = Date.now();
    child = spawn(ELECTRON, [SHELL_MAIN], { env, windowsHide: true, stdio: 'ignore' });
    log(`shell started pid=${child.pid} port=${port}`);
    child.on('error', (error) => log(`shell spawn failed: ${error.message}`));
    child.on('exit', (code) => {
      child = undefined;
      log(`shell exited code=${code}`);
      if (disposed) return;
      delay = Date.now() - startedAt > STABLE_MS ? MIN_RESTART_MS : Math.min(delay * 2, MAX_RESTART_MS);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(launch, delay);
    });
  };

  // 轮询兜底三件事：端口刚就绪、被取消暂停、退避期已过
  const poll = setInterval(launch, POLL_MS);
  poll.unref?.();
  launch();

  ctx.effect(() => () => {
    disposed = true;
    watcher.close();
    clearInterval(poll);
    clearTimeout(retryTimer);
    clearTimeout(reloadTimer);
    core?.dispose();
    child?.kill();
  });
}
