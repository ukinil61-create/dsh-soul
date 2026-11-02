/**
 * 转文字的模型单独一个进程：一句话要算一两秒，放主进程会卡住窗口和唤醒。
 * 由 voice.cjs 的 createScribe 启动，收 { id, wav }，回 { id, text } 或 { id, error }。
 */

const { sherpaPath, modelDir } = process.env.SOUL_STT ? JSON.parse(process.env.SOUL_STT) : {};
const path = require('node:path');
const sherpa = require(sherpaPath);

const SAMPLE_RATE = 16000;
const WAV_HEADER = 44;
const THREADS = 4;

const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
  modelConfig: {
    paraformer: { model: path.join(modelDir, 'model.int8.onnx') },
    tokens: path.join(modelDir, 'tokens.txt'),
    numThreads: THREADS,
    provider: 'cpu',
    debug: 0,
  },
});

process.parentPort.on('message', ({ data: { id, wav } }) => {
  try {
    const bytes = Buffer.from(wav);
    const samples = new Float32Array((bytes.length - WAV_HEADER) >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(WAV_HEADER + i * 2) / 32768;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    recognizer.decode(stream);
    process.parentPort.postMessage({ id, text: recognizer.getResult(stream).text.trim() });
  } catch (error) {
    process.parentPort.postMessage({ id, error: error.message });
  }
});
