import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg } from './config.js';

const file = path.join(cfg.dataDir, 'xau-edge-state.json');
const initial = {
  version: 2,
  state: 'IDLE',
  setup: null,
  latestMarket: null,
  updatedAt: null,
  lastConfirmationAt: 0,
  cooldownUntil: 0,
  events: []
};

let data = structuredClone(initial);
let loaded = false;
let writeChain = Promise.resolve();

export async function loadState() {
  await fs.mkdir(cfg.dataDir, { recursive: true });
  try { data = { ...initial, ...JSON.parse(await fs.readFile(file, 'utf8')) }; }
  catch { await persist(); }
  loaded = true;
  return data;
}
export function getState() { if (!loaded) throw new Error('State not loaded'); return data; }
export async function updateState(mutator) {
  mutator(data);
  data.updatedAt = new Date().toISOString();
  await persist();
  return data;
}
export function addEvent(type, payload = {}) {
  data.events.push({ id: crypto.randomUUID(), type, at: new Date().toISOString(), payload });
  if (data.events.length > 300) data.events.splice(0, data.events.length - 300);
}
export async function persist() {
  const snapshot = JSON.stringify(data, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, file);
  }).catch(() => {});
  return writeChain;
}
