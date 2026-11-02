/**
 * 听和说。都在主进程：唤醒模型是原生模块，语音合成的密钥不能下发到页面。
 *
 *   麦克风音频块 → 唤醒词 → 录一句话（静音结束）→ 交给调用方转文字
 *   回复文字 → 按句切开 → 合成 → 交给页面播放
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createSentenceStream } = require('./subtitle.js');

const SAMPLE_RATE = 16000;
const DSH_HOME = path.join(os.homedir(), '.dsh');
/** install.ps1 下到 desk/kws；装过桌宠的电脑上桌宠已经下过一份，直接用 */
const KWS_ROOT = [path.join(DSH_HOME, 'desk', 'kws'), path.join(DSH_HOME, 'dsh-pet', 'kws')].find((dir) => fs.existsSync(dir)) ?? path.join(DSH_HOME, 'desk', 'kws');
const PET_CONFIG = path.join(DSH_HOME, 'dsh-pet', 'desktop.json');
const SHERPA = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', 'sherpa-onnx-node');

/** 说完一句后静音这么久算结束 */
const END_SILENCE_MS = 1500;
/** 喊完名字后等这么久，还没开口就算了 */
const NO_SPEECH_MS = 8000;
const MAX_RECORD_MS = 25000;
const MIN_SPEECH_RMS = 0.008;
/** 唤醒词的尾音不算开口，不然停顿一下就被判成说完了 */
const WAKE_TAIL_MS = 500;
/** 连续响这么久才算开口，一声杂音不算 */
const SPEECH_START_MS = 200;
/** 唤醒词被认出来要一点时间，连着说的话开头会丢，所以往前多留一段 */
const PRE_ROLL_MS = 1000;
/** 用转文字找名字时，一段话说完多久算一段、最长取多少：名字通常在开头 */
const SEGMENT_END_MS = 500;
const SEGMENT_MAX_MS = 4000;

function encodeWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SAMPLE_RATE, 24); head.writeUInt32LE(SAMPLE_RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * 转文字。没装模型或者出错时返回 null，调用方退回 DSH 自带的识别。
 * 模型占几百 MB 内存，一阵子没说话就退出，下次说话时再载入
 */
function createScribe({ fork, log }) {
  const STT_ROOT = path.join(DSH_HOME, 'speech-to-text', 'paraformer-zh');
  const IDLE_EXIT_MS = 10 * 60 * 1000;
  const TOO_SLOW_MS = 60000;
  let worker = null;
  let idleTimer;
  let nextId = 0;
  const waiting = new Map();

  const finishAll = () => {
    for (const done of waiting.values()) done(null);
    waiting.clear();
  };
  const start = () => {
    worker = fork(path.join(__dirname, 'stt-worker.cjs'), [], {
      env: { ...process.env, SOUL_STT: JSON.stringify({ sherpaPath: SHERPA, modelDir: STT_ROOT }) },
    });
    worker.on('message', ({ id, text, error }) => {
      if (error) log(`stt worker: ${error}`);
      waiting.get(id)?.(error ? null : text);
      waiting.delete(id);
    });
    worker.on('exit', () => {
      worker = null;
      finishAll();
    });
  };

  return {
    transcribe(wav) {
      if (!fs.existsSync(path.join(STT_ROOT, 'model.int8.onnx'))) return Promise.resolve(null);
      if (!worker) start();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => worker?.kill(), IDLE_EXIT_MS);
      const id = ++nextId;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, TOO_SLOW_MS);
        waiting.set(id, (text) => { clearTimeout(timer); resolve(text); });
        worker.postMessage({ id, wav: new Uint8Array(wav) });
      });
    },
    stop() {
      clearTimeout(idleTimer);
      worker?.kill();
    },
  };
}

/** waitMs：开始听之后，等多久没人开口就放弃 */
function createEar({ keywordFile, log, onWake, onUtterance, onGiveUp, waitMs = NO_SPEECH_MS }) {
  let spotter;
  let stream;
  let triedLoad = false;
  let recording = null;
  let noiseFloor = 0.004;
  let muted = false;
  let preRoll = [];
  let preRollMs = 0;
  /** 名字带英文字母时才有：唤醒模型是中文的认不出，每段话转文字找名字 */
  let segmentListener = null;
  let segment = null;
  let segmentBusy = false;

  const joinWav = (chunks) => {
    const all = new Float32Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    return encodeWav(all);
  };

  /** 把一段话切出来交给 segmentListener。上一段还在转文字时，这段不要 */
  const watchSegment = (samples, ms, loud) => {
    if (!segment) {
      if (loud) segment = { chunks: [...preRoll], loudMs: ms, voiced: false, at: 0, lastLoudAt: 0, sent: false };
      return;
    }
    if (!segment.sent) segment.chunks.push(samples);
    segment.at += ms;
    if (loud) {
      segment.lastLoudAt = segment.at;
      segment.loudMs += ms;
      if (segment.loudMs >= SPEECH_START_MS) segment.voiced = true;
    } else if (!segment.voiced) {
      segment = null;
      return;
    }
    const ended = segment.at - segment.lastLoudAt > SEGMENT_END_MS;
    if ((ended || segment.at > SEGMENT_MAX_MS) && !segment.sent) {
      segment.sent = true;
      if (!segmentBusy) {
        segmentBusy = true;
        Promise.resolve(segmentListener(joinWav(segment.chunks)))
          .catch((error) => log(`segment check failed: ${error.message}`))
          .finally(() => { segmentBusy = false; });
      }
    }
    if (ended) segment = null;
  };

  const load = () => {
    if (triedLoad) return;
    triedLoad = true;
    try {
      const dir = fs.readdirSync(KWS_ROOT).map((name) => path.join(KWS_ROOT, name)).find((p) => fs.existsSync(path.join(p, 'tokens.txt')));
      if (!dir) throw new Error(`找不到唤醒模型：${KWS_ROOT}`);
      const files = fs.readdirSync(dir);
      const pick = (prefix) => path.join(dir, files.find((f) => f.startsWith(prefix) && f.endsWith('.int8.onnx')));
      const { KeywordSpotter } = require(SHERPA);
      spotter = new KeywordSpotter({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: pick('encoder'), decoder: pick('decoder'), joiner: pick('joiner') },
          tokens: path.join(dir, 'tokens.txt'),
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        keywordsFile: keywordFile,
      });
      stream = spotter.createStream();
      log('wake word model loaded');
    } catch (error) {
      log(`wake word unavailable: ${error.message}`);
      spotter = undefined;
    }
  };

  const spot = (samples) => {
    load();
    if (!spotter) return '';
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    while (spotter.isReady(stream)) spotter.decode(stream);
    const keyword = spotter.getResult(stream)?.keyword;
    if (keyword) spotter.reset(stream);
    return keyword ? String(keyword) : '';
  };

  /** 时间按音频长度算，不看钟：页面卡一下不会误判，测试也能比实时快 */
  const startRecording = (chunks, ignoreMs, patience = waitMs) => {
    recording = { chunks, at: 0, ignoreMs, patience, loudMs: 0, lastVoiceAt: 0, spokeAt: 0, peak: 0 };
  };

  const finish = () => {
    const { chunks, lastVoiceAt, peak } = recording;
    recording = null;
    log(`${lastVoiceAt ? `recorded ${chunks.length} chunks` : 'heard nothing after wake'} (peak ${peak.toFixed(4)}, noise floor ${noiseFloor.toFixed(4)})`);
    if (!lastVoiceAt) return onGiveUp();
    return onUtterance(joinWav(chunks));
  };

  return {
    /** 唤醒词变了（它有了名字），下一块音频时重新加载 */
    reload() {
      spotter = undefined;
      stream = undefined;
      triedLoad = false;
    },
    /** 自己说话时不听，不然会被自己唤醒 */
    setMuted(value) { muted = value; },
    /** ignoreMs：刚念完话时音箱还有余音，这段不算开口 */
    listenNow(ignoreMs = 0, patience = waitMs) {
      if (recording) return;
      segment = null;
      startRecording([...preRoll], ignoreMs, patience);
    },
    stopListening() {
      recording = null;
    },
    setSegmentListener(listener) {
      segmentListener = listener;
      segment = null;
    },
    feed(samples, wakeEnabled) {
      if (muted) return;
      const level = rms(samples);
      const ms = (samples.length / SAMPLE_RATE) * 1000;
      if (recording) {
        recording.chunks.push(samples);
        recording.at += ms;
        recording.peak = Math.max(recording.peak, level);
        const loud = level > Math.max(MIN_SPEECH_RMS, noiseFloor * 3);
        if (loud && recording.at > recording.ignoreMs) {
          recording.loudMs += ms;
          if (recording.loudMs >= SPEECH_START_MS) {
            recording.lastVoiceAt = recording.at;
            recording.spokeAt ||= recording.at;
          }
        } else if (!recording.lastVoiceAt) {
          recording.loudMs = 0;
        }
        if (!recording.lastVoiceAt) {
          // 还没开口时可能等很久：只留开口前的一小段，噪声基线也继续跟着
          let keptMs = recording.chunks.reduce((sum, c) => sum + (c.length / SAMPLE_RATE) * 1000, 0);
          while (keptMs - ms >= PRE_ROLL_MS + SPEECH_START_MS) keptMs -= (recording.chunks.shift().length / SAMPLE_RATE) * 1000;
          if (!loud) noiseFloor = level < noiseFloor * 3 ? noiseFloor * .98 + level * .02 : noiseFloor * 1.002;
        }
        const quiet = recording.lastVoiceAt && recording.at - recording.lastVoiceAt > END_SILENCE_MS;
        const nothing = !recording.lastVoiceAt && recording.at > recording.patience;
        const tooLong = recording.spokeAt && recording.at - recording.spokeAt > MAX_RECORD_MS;
        if (quiet || nothing || tooLong) finish();
        return;
      }
      // 只跟着安静时的声音走。说话声算进来，喊完名字基线就高了，接下来的话反而听不见
      noiseFloor = level < noiseFloor * 3 ? noiseFloor * .98 + level * .02 : noiseFloor * 1.002;
      preRoll.push(samples);
      preRollMs += ms;
      while (preRollMs - ms >= PRE_ROLL_MS) preRollMs -= (preRoll.shift().length / SAMPLE_RATE) * 1000;
      if (!wakeEnabled) return;
      if (segmentListener) watchSegment(samples, ms, level > Math.max(MIN_SPEECH_RMS, noiseFloor * 3));
      const keyword = spot(samples);
      if (keyword) {
        log(`wake word heard: ${keyword}`);
        segment = null;
        startRecording(preRoll, WAKE_TAIL_MS);
        preRoll = [];
        preRollMs = 0;
        onWake();
      }
    },
  };
}

function readKeys(log, keyFile) {
  let pet = {};
  try {
    pet = JSON.parse(fs.readFileSync(PET_CONFIG, 'utf8').replace(/^\uFEFF/, '')).voice || {};
  } catch {
    /* 没有桌宠配置就只看设置里填的密钥文件 */
  }
  if (!keyFile && pet.appid && pet.token) return { appid: String(pet.appid), token: String(pet.token) };
  const file = keyFile || pet.keyFile;
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (raw.volc_appid && raw.volc_token) return { appid: String(raw.volc_appid), token: String(raw.volc_token) };
  } catch (error) {
    log(`voice key unavailable: ${error.code || error.message}`);
  }
  return null;
}

/** 响应是按行 JSON，每行 data 是 base64，按顺序拼起来就是完整 mp3 */
function synthesize(text, speaker, keys, voice) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      user: { uid: 'dsh-desk' },
      req_params: { text, speaker, audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: Number(voice.rate) || 0 } },
    });
    const req = https.request({
      hostname: 'openspeech.bytedance.com',
      path: '/api/v3/tts/unidirectional',
      method: 'POST',
      timeout: 30000,
      headers: {
        'X-Api-App-Id': keys.appid,
        'X-Api-Access-Key': keys.token,
        'X-Api-Resource-Id': voice.model || 'seed-tts-2.0',
        'X-Api-Request-Id': crypto.randomUUID(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        const parts = [];
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          let item;
          try { item = JSON.parse(line); } catch { continue; }
          if (item.data) parts.push(Buffer.from(item.data, 'base64'));
          else if (item.code && item.code !== 0 && item.code !== 20000000) return reject(new Error(`TTS ${item.code}: ${item.message || ''}`));
        }
        return parts.length ? resolve(Buffer.concat(parts)) : reject(new Error('TTS 没有返回音频'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('TTS 超时')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * MiniMax：用户本机配好的 Python 工具，密钥用 Windows DPAPI 加密，只有它自己解得开。
 * 所以这里不碰密钥，起一个常驻小助手，省掉每句话启动 Python 的时间。
 */
let minimaxHelper = null;
const minimaxWaiting = new Map();
let minimaxSerial = 0;

function minimaxProcess(log) {
  if (minimaxHelper) return minimaxHelper;
  const child = spawn('python', ['-u', path.join(__dirname, 'minimax_tts.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      const waiter = minimaxWaiting.get(reply.id);
      minimaxWaiting.delete(reply.id);
      if (!waiter) continue;
      if (reply.error) waiter.reject(new Error(`MiniMax: ${reply.error}`));
      else waiter.resolve(Buffer.from(reply.audio, 'base64'));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => log(`minimax helper: ${chunk.trim().slice(0, 300)}`));
  const fail = (message) => {
    minimaxHelper = null;
    for (const waiter of minimaxWaiting.values()) waiter.reject(new Error(message));
    minimaxWaiting.clear();
  };
  child.on('error', (error) => fail(`MiniMax 小助手启动失败：${error.message}`));
  child.on('exit', () => fail('MiniMax 小助手退出了'));
  minimaxHelper = child;
  return child;
}

function synthesizeMinimax(text, voice, log) {
  return new Promise((resolve, reject) => {
    const id = ++minimaxSerial;
    minimaxWaiting.set(id, { resolve, reject });
    minimaxProcess(log).stdin.write(`${JSON.stringify({
      id,
      tool_dir: voice.minimax.toolDir,
      text,
      model: voice.minimax.model,
      voice: voice.minimax.voice,
      speed: Number(voice.minimax.speed) || 1,
    })}\n`);
  });
}

/** 音色列表，给设置页的下拉提示用 */
function minimaxVoices(toolDir) {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(toolDir, 'voices.json'), 'utf8').replace(/^﻿/, ''));
    return (catalog.system_voice ?? []).map((v) => ({ id: v.voice_id, name: v.voice_name ?? v.voice_id }));
  } catch {
    return [];
  }
}

/** 边收回复边切句：句子一完整就去合成，不用等整段说完 */
function createMouth({ getVoice, log, onAudio, onIdle }) {
  const stream = createSentenceStream();
  let chain = Promise.resolve();
  let serial = 0;
  /** 已排队或正在播放的句子。打断时清空，被打断的句子回来也不算数 */
  const live = new Set();
  let speakerIndex = 0;

  const enqueue = (text) => {
    const voice = getVoice();
    if (voice.provider === 'minimax') {
      const id = ++serial;
      live.add(id);
      chain = chain.then(async () => {
        if (!live.has(id)) return;
        try {
          const bytes = await synthesizeMinimax(text, voice, log);
          if (live.has(id)) onAudio(id, bytes, text);
        } catch (error) {
          log(`tts failed: ${error.message}`);
          if (live.delete(id) && !live.size) onIdle();
        }
      });
      return;
    }
    const speakers = voice.speakers;
    const keys = readKeys(log, voice.keyFile);
    if (!keys) return;
    const id = ++serial;
    live.add(id);
    chain = chain.then(async () => {
      while (live.has(id) && speakerIndex < speakers.length) {
        try {
          const bytes = await synthesize(text, speakers[speakerIndex], keys, voice);
          if (live.has(id)) onAudio(id, bytes, text);
          return;
        } catch (error) {
          log(`tts failed with ${speakers[speakerIndex]}: ${error.message}`);
          // 服务端明确拒绝才可能是音色的问题，换下一个；网络问题换了也没用
          if (!/TTS \d/.test(error.message)) break;
          speakerIndex++;
        }
      }
      if (live.delete(id) && !live.size) onIdle();
    });
  };

  return {
    feed(delta) {
      stream.push(delta).forEach(enqueue);
    },
    flush() {
      stream.flush().forEach(enqueue);
      if (!live.size) onIdle();
    },
    played(id) {
      if (live.delete(id) && !live.size) onIdle();
    },
    stop() {
      live.clear();
      stream.reset();
    },
    /** 换了声音设置：之前被拒绝的音色也可以重新试 */
    resetVoice() {
      speakerIndex = 0;
    },
  };
}

module.exports = { createEar, createMouth, createScribe, minimaxVoices };
