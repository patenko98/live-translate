// Opus-MT (ru<->en) in the browser via transformers.js (ONNX Runtime Web, int8). Runs in a worker.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

// The models are published next to the site (pinned, see models/README.md), never fetched from a third party at run time.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('models/', self.location).href;
const MODELS = { 'ru-en': 'Xenova/opus-mt-ru-en', 'en-ru': 'Xenova/opus-mt-en-ru' };
const pipes = {};
let ready = null; // both models loaded; translating while they are still loading corrupts the ONNX sessions
let lowMemory = false; // iPad/iPhone: Safari kills the page when two models are held in memory
let current = null; // lowMemory: the only model in memory
let chain = Promise.resolve(); // messages run one at a time, so a model is never released while it is in use

const loadAll = () => (ready ||= lowMemory ? preloadOneByOne() : Promise.all([load('ru-en'), load('en-ru')]));

/** Downloads both into the browser cache but keeps only one in memory. */
async function preloadOneByOne() {
  await acquire('en-ru');
  await acquire('ru-en');
}

/** The model of [pair]; on lowMemory the other one is released first. */
async function acquire(pair) {
  if (lowMemory && current !== pair) {
    if (current) {
      const old = pipes[current];
      delete pipes[current];
      await (await old).dispose();
    }
    current = pair;
  }
  return load(pair);
}

function load(pair) {
  if (!pipes[pair]) {
    pipes[pair] = pipeline('translation', MODELS[pair], {
      dtype: 'q8',
      progress_callback: (p) => postMessage({ type: 'progress', pair, p }),
    });
  }
  return pipes[pair];
}

onmessage = (e) => { chain = chain.then(() => handle(e.data)); };

async function handle(m) {
  try {
    if (m.type === 'init') {
      lowMemory = !!m.lowMemory;
      await loadAll();
      postMessage({ type: 'ready' });
    } else if (m.type === 'translate') {
      await loadAll();
      const p = await acquire(m.src + '-' + m.tgt);
      // One sentence at a time: batching pads the inputs and makes Opus-MT emit stray "......".
      const parts = [];
      for (const s of m.sentences) {
        const out = await p(s, { max_new_tokens: 160 });
        parts.push(out[0].translation_text);
      }
      postMessage({ type: 'result', id: m.id, text: parts.join(' ') });
    }
  } catch (err) {
    postMessage(m.type === 'translate'
      ? { type: 'result', id: m.id, error: String(err && err.message || err) }
      : { type: 'error', message: String(err && err.message || err) });
  }
}
