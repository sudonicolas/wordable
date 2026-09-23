// Main-thread view of the lexicon: the word list, per-word metadata, and lazily loaded definition shards.

export const DATA = new URL('../data/', import.meta.url)

export const F = { def: 1, vec: 2, proper: 4, abbr: 8, infl: 16, pron: 32, variant: 64, taxon: 128, archaic: 256, sensitive: 512, negated: 1024, defvec: 2048 }
export const POS = { n: 1, v: 2, a: 4, r: 8 }
export const POS_SHORT = { n: 'n.', v: 'v.', a: 'adj.', r: 'adv.' }
export const POS_LONG = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb', name: 'name' }

export const lex = { words: [], N: 0, flags: null, zipf: null, syl: null, pos: null, manifest: null }

export async function loadLexicon () {
  const [txt, meta, manifest] = await Promise.all([
    fetch(new URL('words.txt', DATA)).then(ok).then(r => r.text()),
    fetch(new URL('meta.bin', DATA)).then(ok).then(r => r.arrayBuffer()),
    fetch(new URL('manifest.json', DATA)).then(ok).then(r => r.json())
  ])
  const words = txt.split('\n')
  const N = words.length
  Object.assign(lex, {
    words,
    N,
    manifest,
    flags: new Uint16Array(meta, 0, N),
    zipf: new Uint8Array(meta, 2 * N, N),
    syl: new Uint8Array(meta, 3 * N, N),
    pos: new Uint8Array(meta, 4 * N, N)
  })
  return lex
}

function ok (r) {
  if (!r.ok) throw new Error(`${r.url} → ${r.status}. Run "make data" to build the lexicon.`)
  return r
}

export function idOf (w) {
  const { words, N } = lex
  let lo = 0
  let hi = N
  while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid] < w) lo = mid + 1; else hi = mid }
  return lo < N && words[lo] === w ? lo : -1
}

// words sorted: first id with prefix, used for suggestions
export function prefixRange (p) {
  const { words, N } = lex
  let lo = 0
  let hi = N
  while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid] < p) lo = mid + 1; else hi = mid }
  let end = lo
  while (end < N && words[end].startsWith(p) && end - lo < 4000) end++
  return [lo, end]
}

export function suggest (p, n = 8) {
  p = p.toLowerCase().replace(/[^a-z]/g, '')
  if (!p) return []
  const [lo, hi] = prefixRange(p)
  const ids = []
  for (let i = lo; i < hi; i++) ids.push(i)
  const exact = idOf(p)
  ids.sort((a, b) => (b === exact) - (a === exact) || lex.zipf[b] - lex.zipf[a] || lex.words[a].length - lex.words[b].length)
  return ids.slice(0, n)
}

// ------------------------------------------------------------------ definitions

const shards = new Map()
const listeners = new Set()

export function onShard (fn) { listeners.add(fn); return () => listeners.delete(fn) }

export function loadShard (letter) {
  let p = shards.get(letter)
  if (!p) {
    p = fetch(new URL(`defs/${letter}.json`, DATA)).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
    p.then(d => { p.data = d; for (const fn of listeners) fn(letter) })
    shards.set(letter, p)
  }
  return p
}

export async function entry (w) {
  if (!w) return null
  return (await loadShard(w[0]))[w] || null
}

// synchronous peek; undefined while the shard is still loading (and starts the load)
export function peekEntry (w) {
  const p = shards.get(w[0]) || loadShard(w[0])
  if (!p.data) return undefined
  return p.data[w] || null
}

export function firstGloss (w) {
  const e = peekEntry(w)
  if (e === undefined) return undefined
  if (!e) return ''
  const s = (e.s && e.s[0]) || (e.x && e.x[0])
  if (s) return s[1]
  if (e.b) return `form of ${e.b}`
  return ''
}

// ------------------------------------------------------------------ formatting

export const BANDS = [
  { min: 50, label: 'Very common' },
  { min: 40, label: 'Common' },
  { min: 30, label: 'Familiar' },
  { min: 20, label: 'Uncommon' },
  { min: 1, label: 'Rare' },
  { min: 0, label: 'Unattested' }
]

export function band (z) { return BANDS.find(b => z >= b.min).label }

export function posList (mask) {
  const out = []
  for (const [k, bit] of Object.entries(POS)) if (mask & bit) out.push(k)
  return out
}

export function posShort (mask) { return posList(mask).map(k => POS_SHORT[k]).join(' ') }

export function metaLine (id) {
  const p = posShort(lex.pos[id])
  const s = lex.syl[id]
  return [p, `${s} syl`, `${lex.words[id].length}`].filter(Boolean).join(' · ')
}

export const fmt = new Intl.NumberFormat('en-US')
