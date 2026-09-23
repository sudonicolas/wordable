// Promise-based RPC to the engine worker. `latest(channel, …)` drops stale answers so fast typing never flickers.

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
const pending = new Map()
const progress = new Set()
let seq = 0

worker.onmessage = (ev) => {
  const msg = ev.data
  if (msg.type === 'progress') { for (const fn of progress) fn(msg); return }
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.ok) p.resolve(msg.result)
  else p.reject(new Error(msg.error))
}
worker.onerror = (e) => console.error('engine worker error', e)

export function call (type, payload) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, type, payload })
  })
}

const channels = new Map()
export const STALE = Symbol('stale')

export async function latest (channel, type, payload) {
  const token = (channels.get(channel) || 0) + 1
  channels.set(channel, token)
  const res = await call(type, payload)
  return channels.get(channel) === token ? res : STALE
}

export function onProgress (fn) { progress.add(fn); return () => progress.delete(fn) }
