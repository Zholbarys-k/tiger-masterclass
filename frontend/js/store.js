/* Состояние и «реальное время»: опрос /api/state и подписки на изменения. */

import { api } from "./api.js";

const POLL_INTERVAL = 4000;

export const store = {
  user: null,
  team: null,
  versions: {},
};

const listeners = new Map();   // key -> Set<callback>
let timer = null;
let firstPollDone = false;

export function subscribe(keys, callback) {
  const list = Array.isArray(keys) ? keys : [keys];
  list.forEach((key) => {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(callback);
  });
  return () => list.forEach((key) => listeners.get(key)?.delete(callback));
}

function emit(changedKeys) {
  const called = new Set();
  changedKeys.forEach((key) => {
    listeners.get(key)?.forEach((callback) => {
      if (called.has(callback)) return;
      called.add(callback);
      try {
        callback(key);
      } catch (error) {
        console.error("store listener failed", error);
      }
    });
  });
}

async function poll() {
  try {
    const data = await api.state();
    const changed = [];
    for (const [key, version] of Object.entries(data.versions || {})) {
      if (store.versions[key] !== version) {
        if (firstPollDone) changed.push(key);
        store.versions[key] = version;
      }
    }
    firstPollDone = true;
    document.body.dataset.online = "1";
    if (changed.length) emit(changed);
  } catch (error) {
    document.body.dataset.online = "0";
  }
}

export function startPolling() {
  if (timer) return;
  poll();
  timer = setInterval(() => {
    if (document.visibilityState === "visible") poll();
  }, POLL_INTERVAL);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });
}

export function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function forcePoll() {
  return poll();
}

export async function loadMe() {
  const data = await api.me();
  store.user = data.user;
  store.team = data.team;
  return data;
}
