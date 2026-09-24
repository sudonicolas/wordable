// App state: one object, mirrored to the URL hash so every view is linkable and back/forward works.

import { F } from './lexicon.js'

export const LIMITS = { len: [1, 32], syl: [1, 12], zipf: [0, 80] }

export const DEFAULTS = Object.freeze({
  route: 'explore',
  q: '',
  qm: 'starts',
  len: LIMITS.len,
  syl: LIMITS.syl,
  zipf: LIMITS.zipf,
  pos: 0,
  inc: '',
  exc: '',
  pre: '',
  mid: '',
  suf: '',
  dq: '',
  hide: 0,
  need: 0,
  shape: 0,
  shapeNot: 0,
  saved: 'any',
  sort: 'az',
  group: 'letter',
  view: 'grid',
  size: 'm',
  seed: 1,
  w: '',
  seeds: [],
  modes: ['meaning'],
  bias: 0,
  limit: 150,
  layout: 'cloud',
  list: ''
})

export const FILTER_KEYS = ['q', 'qm', 'len', 'syl', 'zipf', 'pos', 'inc', 'exc', 'pre', 'mid', 'suf', 'dq', 'hide', 'need', 'shape', 'shapeNot', 'saved']

export const SHAPE = { double: 1, isogram: 2, palindrome: 4, pronounceable: 8, vowelStart: 16, vowelEnd: 32 }

const flagNames = Object.keys(F)
const shapeNames = Object.keys(SHAPE)
const posNames = { n: 1, v: 2, a: 4, r: 8 }

const maskCodec = (names, table) => ({
  enc: m => names.filter(n => m & table[n]).join(','),
  dec: s => s.split(',').reduce((m, n) => m | (table[n] || 0), 0)
})
const rangeCodec = {
  enc: r => `${r[0]}-${r[1]}`,
  dec: s => { const [a, b] = s.split('-').map(Number); return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null }
}
const str = { enc: s => s, dec: s => s }
const num = { enc: n => String(n), dec: s => (Number.isFinite(+s) ? +s : null) }

const CODECS = {
  q: str,
  qm: str,
  len: rangeCodec,
  syl: rangeCodec,
  zipf: rangeCodec,
  pos: { enc: m => Object.keys(posNames).filter(k => m & posNames[k]).join(''), dec: s => [...s].reduce((m, c) => m | (posNames[c] || 0), 0) },
  inc: str,
  exc: str,
  pre: str,
  mid: str,
  suf: str,
  dq: str,
  hide: maskCodec(flagNames, F),
  need: maskCodec(flagNames, F),
  shape: maskCodec(shapeNames, SHAPE),
  shapeNot: maskCodec(shapeNames, SHAPE),
  saved: str,
  sort: str,
  group: str,
  view: str,
  size: str,
  seed: num,
  w: str,
  seeds: {
    enc: a => a.map(s => (s.sign < 0 ? '-' : '') + s.w).join(','),
    dec: s => s.split(',').filter(Boolean).map(t => (t.startsWith('-') ? { w: t.slice(1), sign: -1 } : { w: t, sign: 1 }))
  },
  modes: { enc: a => a.join(','), dec: s => s.split(',').filter(m => ['meaning', 'sound', 'form'].includes(m)) },
  bias: num,
  limit: num,
  layout: str,
  list: str
}

const ROUTES = ['explore', 'cloud', 'lists']
const LAST = 'wordable.last'

let state = { ...DEFAULTS }
const subs = new Set()

function same (a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b) }

export function toHash (s) {
  const params = new URLSearchParams()
  for (const [k, c] of Object.entries(CODECS)) {
    if (same(s[k], DEFAULTS[k])) continue
    const v = c.enc(s[k])
    if (v !== '') params.set(k, v)
  }
  const qs = params.toString().replace(/%2C/g, ',')
  return `#/${s.route === 'explore' ? '' : s.route}${qs ? '?' + qs : ''}`
}

export function fromHash (hash) {
  const m = /^#\/?([a-z]*)(?:\?(.*))?$/.exec(hash || '')
  const s = { ...DEFAULTS }
  if (!m) return s
  s.route = ROUTES.includes(m[1]) ? m[1] : 'explore'
  const params = new URLSearchParams(m[2] || '')
  for (const [k, v] of params) {
    const c = CODECS[k]
    if (!c) continue
    const d = c.dec(v)
    if (d !== null && d !== undefined) s[k] = d
  }
  // older links searched "contains"/"ends" from the box; those now live in the Letters filter
  if ((s.qm === 'contains' || s.qm === 'ends') && !/[*?/]/.test(s.q)) {
    const part = s.q.toLowerCase().replace(/[^a-z]/g, '')
    if (part) s[s.qm === 'ends' ? 'suf' : 'mid'] = part
    s.q = ''
    s.qm = 'starts'
  } else if (s.qm !== 'defs') s.qm = 'starts'
  return s
}

export const store = {
  get () { return state },
  subscribe (fn) { subs.add(fn); return () => subs.delete(fn) },
  // push: add a history entry (word navigation, route changes); otherwise replace
  set (patch, { push = false } = {}) {
    const next = { ...state, ...patch }
    const changed = Object.keys(patch).filter(k => !same(state[k], next[k]))
    if (!changed.length) return
    state = next
    const hash = toHash(state)
    if (hash !== location.hash) history[push ? 'pushState' : 'replaceState'](null, '', hash || '#/')
    try { localStorage.setItem(LAST, hash) } catch {}
    emit(changed)
  },
  resetFilters (patch = {}) {
    const p = {}
    for (const k of FILTER_KEYS) if (k !== 'q' && k !== 'qm') p[k] = DEFAULTS[k]
    this.set({ ...p, ...patch })
  },
  init () {
    let hash = location.hash
    if (!hash || hash === '#' || hash === '#/') {
      try { const last = localStorage.getItem(LAST); if (last) { hash = last; history.replaceState(null, '', last) } } catch {}
    }
    state = fromHash(hash)
    window.addEventListener('popstate', () => {
      const next = fromHash(location.hash)
      const changed = Object.keys(next).filter(k => !same(state[k], next[k]))
      state = next
      if (changed.length) emit(changed)
    })
  }
}

function emit (changed) {
  const set = new Set(changed)
  for (const fn of subs) fn(state, set)
}

export function filterOf (s = state) {
  const f = {}
  for (const k of FILTER_KEYS) f[k] = s[k]
  return f
}

// how many non-default filters are active (excluding the text query)
export function activeFilterCount (s = state) {
  return FILTER_KEYS.filter(k => k !== 'q' && k !== 'qm' && !same(s[k], DEFAULTS[k])).length
}
