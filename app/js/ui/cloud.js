// Cloud: seed words in, a field of neighbours out. Seeds can pull (+) or push (−); modes blend meaning,
// sound and spelling; results render as a typographic cloud, as clusters of senses, or as a ranked receipt.

import { store, filterOf } from '../state.js'
import { lex, idOf, suggest, fmt } from '../lexicon.js'
import { latest, STALE } from '../engine.js'
import { lists } from '../lists.js'
import { selectWord, toggleSave } from '../actions.js'
import { h, fill } from './dom.js'

const MODES = [['meaning', 'Meaning'], ['sound', 'Sound'], ['form', 'Spelling']]
const BIAS = [[1, 'Familiar'], [0, 'Balanced'], [-1, 'Obscure']]
const LIMITS = [60, 150, 300]
const LAYOUTS = [['cloud', 'Cloud'], ['clusters', 'Clusters'], ['ranked', 'Ranked']]
const EXAMPLES = [
  [['light']], [['ocean'], ['calm']], [['swift'], ['-car']], [['forge'], ['craft']], [['north'], ['star']], [['ember']], [['kin'], ['trust']]
]
const WHY = { meaning: 'meaning', sound: 'sound', form: 'spelling', synonym: 'synonym', related: 'related' }

let root
let head
let body
let status
let last = null

export function mountCloud (el) {
  root = el
  head = h('div', { class: 'cloud-head' })
  body = h('div', { class: 'cloud-body', tabindex: '-1' })
  fill(root, head, body)
  body.addEventListener('click', onClick)
  body.addEventListener('dblclick', onDblClick)
  store.subscribe((s, ch) => {
    if (s.route !== 'cloud') return
    if (ch.has('route') || ch.has('seeds') || ch.has('modes') || ch.has('bias') || ch.has('limit') || ch.has('layout')) renderHead()
    if (ch.has('route') || ['seeds', 'modes', 'bias', 'limit', 'layout', 'len', 'syl', 'zipf', 'pos', 'inc', 'exc', 'pre', 'mid', 'suf', 'dq', 'hide', 'need', 'shape', 'shapeNot', 'saved'].some(k => ch.has(k))) run()
    else if (ch.has('w')) markSelected()
  })
  lists.subscribe(() => { if (store.get().route === 'cloud') markSaved() })
  if (store.get().route === 'cloud') { renderHead(); run() }
}

// ------------------------------------------------------------------ header: seeds + controls

function renderHead () {
  const s = store.get()
  const input = h('input', { class: 'seed-input', placeholder: s.seeds.length ? 'Add a word…' : 'Type a word or a few, then Enter', 'aria-label': 'Add seed words', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' })
  const box = h('div', { class: 'suggest', role: 'listbox', hidden: true })
  const wrap = h('div', { class: 'seed-input-wrap' }, input, box)
  let opts = []
  let active = 0

  const drawSuggest = () => {
    const v = input.value.trim().split(/\s+/).pop() || ''
    opts = v.length ? suggest(v.replace(/^[-+]/, ''), 7) : []
    box.hidden = !opts.length
    fill(box, ...opts.map((id, k) => h('button', {
      role: 'option',
      'aria-selected': String(k === active),
      tabindex: '-1',
      onmousedown: e => { e.preventDefault(); commit(lex.words[id]) }
    }, lex.words[id], h('span', { class: 'muted' }, lex.zipf[id] ? (lex.zipf[id] / 10).toFixed(1) : '·'))))
  }
  const commit = (override) => {
    const raw = input.value.trim()
    const toks = override ? [...raw.split(/\s+/).slice(0, -1), (raw.split(/\s+/).pop().startsWith('-') ? '-' : '') + override] : raw.split(/[\s,]+/)
    const add = []
    const miss = []
    for (let t of toks) {
      if (!t) continue
      const sign = t.startsWith('-') ? -1 : 1
      t = t.replace(/^[-+]/, '').toLowerCase().replace(/[^a-z]/g, '')
      if (!t) continue
      if (idOf(t) >= 0) add.push({ w: t, sign })
      else miss.push(t)
    }
    input.value = ''
    active = 0
    drawSuggest()
    if (add.length) {
      const cur = store.get().seeds.filter(x => !add.some(a => a.w === x.w))
      store.set({ seeds: [...cur, ...add] }, { push: true })
    }
    if (miss.length) setStatus(`Not in the list: ${miss.join(', ')}`)
    requestAnimationFrame(() => head.querySelector('.seed-input')?.focus())
  }
  input.addEventListener('input', () => { active = 0; drawSuggest() })
  input.addEventListener('blur', () => { box.hidden = true })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && opts.length) { e.preventDefault(); active = (active + 1) % opts.length; drawSuggest() } else if (e.key === 'ArrowUp' && opts.length) { e.preventDefault(); active = (active - 1 + opts.length) % opts.length; drawSuggest() } else if (e.key === 'Enter') {
      e.preventDefault()
      const single = !/\s/.test(input.value.trim())
      commit(single && opts.length && !box.hidden ? lex.words[opts[active]] : null)
    } else if (e.key === 'Tab' && opts.length && !box.hidden && input.value) { e.preventDefault(); commit(lex.words[opts[active]]) } else if (e.key === 'Backspace' && !input.value && store.get().seeds.length) {
      store.set({ seeds: store.get().seeds.slice(0, -1) })
    } else if (e.key === 'Escape') { box.hidden = true; input.blur() }
  })

  const chips = s.seeds.map((seed, k) => h('span', { class: 'seed' + (seed.sign < 0 ? ' neg' : '') },
    h('button', { class: 'sign', title: seed.sign < 0 ? 'Pushing away — click to pull toward' : 'Pulling toward — click to push away', 'aria-label': `Flip ${seed.w}`, onclick: () => flip(k) }, seed.sign < 0 ? '−' : '+'),
    h('a', { class: 't', href: '#', 'data-w': seed.w, onclick: e => { e.preventDefault(); selectWord(seed.w) } }, seed.w),
    h('button', { class: 'x', 'aria-label': `Remove ${seed.w}`, title: 'Remove', onclick: () => store.set({ seeds: store.get().seeds.filter((_, j) => j !== k) }) }, '×')))

  status = h('span', { class: 'status' })
  const seg = (label, items, cur, on, multi) => h('span', { class: 'ctl' }, label,
    h('span', { class: 'seg', role: multi ? 'group' : 'radiogroup', 'aria-label': label },
      items.map(([v, l]) => h('button', multi
        ? { 'aria-pressed': String(cur.includes(v)), onclick: () => on(v) }
        : { role: 'radio', 'aria-checked': String(cur === v), onclick: () => on(v) }, l))))

  fill(head,
    h('div', { class: 'seeds' }, chips, wrap,
      s.seeds.length ? h('button', { class: 'btn ghost', onclick: () => store.set({ seeds: [] }, { push: true }), title: 'Clear seeds' }, 'Clear') : null),
    h('div', { class: 'cloud-controls' },
      seg('By', MODES, s.modes, v => {
        const m = s.modes.includes(v) ? s.modes.filter(x => x !== v) : [...s.modes, v]
        store.set({ modes: m.length ? MODES.map(x => x[0]).filter(x => m.includes(x)) : [v] })
      }, true),
      seg('Lean', BIAS, s.bias, v => store.set({ bias: v })),
      seg('Show', LIMITS.map(n => [n, String(n)]), s.limit, v => store.set({ limit: v })),
      seg('As', LAYOUTS, s.layout, v => store.set({ layout: v })),
      h('span', { class: 'grow' }),
      status)
  )
}

function flip (k) {
  const seeds = store.get().seeds.map((x, j) => (j === k ? { ...x, sign: -x.sign } : x))
  store.set({ seeds })
}

function setStatus (t) { if (status) status.textContent = t }

// ------------------------------------------------------------------ results

async function run () {
  const s = store.get()
  const seeds = s.seeds.map(x => ({ id: idOf(x.w), sign: x.sign, w: x.w })).filter(x => x.id >= 0)
  if (!seeds.length) { last = null; intro(); return }
  if (!seeds.some(x => x.sign > 0)) { fill(body, h('div', { class: 'cloud-intro' }, h('strong', null, 'Add a word to pull toward.'), h('p', null, 'Negative seeds only push away — the cloud needs at least one positive seed.'))); return }
  setStatus('Computing')
  const f = filterOf(s)
  if (f.saved !== 'any') { f.savedIds = [...lists.saved()].map(idOf).filter(i => i >= 0); f.savedKey = f.savedIds.join(',') }
  const res = await latest('cloud', 'cloud', { seeds, modes: Object.fromEntries(s.modes.map(m => [m, true])), bias: s.bias, limit: s.limit, filter: f, cluster: s.layout === 'clusters' })
  if (res === STALE) return
  last = res
  const miss = res.missing?.length ? ` · no ${res.missing.join('/')} data for these seeds` : ''
  setStatus(`${fmt.format(res.items.length)} words · ${Math.round(res.took)} ms${miss}`)
  draw()
}

function draw () {
  const s = store.get()
  if (!last) return
  const items = last.items
  if (!items.length) {
    fill(body, h('div', { class: 'cloud-intro' }, h('strong', null, 'Nothing nearby.'), h('p', null, 'The filters may be too tight, or these seeds have no data for the chosen modes. Try Meaning, or loosen the filters.')))
    return
  }
  let main
  if (s.layout === 'ranked') main = ranked(items)
  else if (s.layout === 'clusters' && last.clusters) main = clusters(last.clusters, items)
  else main = cloud(items)
  const blends = last.blends?.length ? h('section', { class: 'blends' }, h('h4', null, 'Blends — coined from your seeds'), h('div', { class: 'words' }, last.blends.map(b => h('span', { 'data-blend': b.w, title: b.real ? 'Existing word' : 'Coined — click to save, Shift-click to inspect' }, b.w)))) : null
  fill(body, ...[main, blends].filter(Boolean), h('p', { class: 'fine', style: { marginTop: '40px' } }, 'Click to inspect · Shift-click to add as seed · Alt-click to push away · Filters above apply'))
  body.scrollTop = 0
  markSaved()
  markSelected()
}

function scale (items) {
  const min = items[items.length - 1].score
  const span = Math.max(1e-6, 1 - min)
  return sc => { const t = Math.max(0, (sc - min) / span); return t }
}

function word (it, t, big = 40, small = 13) {
  const w = lex.words[it.id]
  const size = small + (big - small) * Math.pow(t, 1.7)
  return h('a', {
    href: `#/cloud?w=${w}`,
    'data-w': w,
    title: `${w} · ${WHY[it.why] || it.why} · ${(it.score * 100).toFixed(0)}`,
    style: { fontSize: `calc(${size.toFixed(1)}px * var(--cs, 1))`, fontWeight: String(Math.round(400 + 200 * t)), opacity: (0.5 + 0.5 * t).toFixed(2) }
  }, w)
}

function cloud (items) {
  const t = scale(items)
  return h('div', { class: 'cloud' }, items.map(it => word(it, t(it.score))))
}

function clusters (groups, items) {
  const t = scale(items)
  const byId = new Map(items.map(it => [it.id, it]))
  return h('div', { class: 'clusters' }, groups.map(g => h('section', { class: 'cluster' },
    h('h4', null, h('b', null, lex.words[g.label]), h('span', { class: 'leader' }), String(g.ids.length)),
    h('div', { class: 'cloud' }, g.ids.map(id => word(byId.get(id), t(byId.get(id).score), 26, 13))))))
}

function ranked (items) {
  return h('ol', { class: 'ranked' }, items.map((it, k) => {
    const w = lex.words[it.id]
    return h('li', null,
      h('span', { class: 'n' }, String(k + 1).padStart(2, '0')),
      h('a', { 'data-w': w, href: `#/cloud?w=${w}` }, w),
      h('span', { class: 'why' }, WHY[it.why] || it.why),
      h('span', { class: 'leader' }),
      h('span', { class: 'sc' }, h('i', { style: { width: Math.round(it.score * 48) + 'px' } }), (it.score * 100).toFixed(0)))
  }))
}

function intro () {
  setStatus('')
  fill(body, h('div', { class: 'cloud-intro' },
    h('strong', null, 'Grow a field of words from a few seeds.'),
    h('p', null, 'Add one or more words above. Meaning finds words used and defined alike — synonyms, associations, rare cousins. Sound finds rhymes and near-homophones. Spelling finds shared roots and shapes. Push a seed away (−) to steer: ', h('em', null, 'swift − car'), '.'),
    h('p', { style: { marginTop: '10px' } }, 'Everything respects the filters above — set Brandable or a length range first for naming work.'),
    h('div', { class: 'try' }, EXAMPLES.map(ex => h('button', { class: 'btn', onclick: () => store.set({ seeds: ex.map(([w]) => (w.startsWith('-') ? { w: w.slice(1), sign: -1 } : { w, sign: 1 })) }, { push: true }) }, ex.map(([w]) => w.replace('-', '− ')).join(' + ').replace('+ −', '−'))))))
}

function onClick (e) {
  const b = e.target.closest('[data-blend]')
  if (b) {
    const w = b.dataset.blend
    if (idOf(w) >= 0 || e.shiftKey) store.set({ w }, { push: true })
    else toggleSave(w)
    return
  }
  const a = e.target.closest('[data-w]')
  if (!a) return
  e.preventDefault()
  selectWord(a.dataset.w, e)
}

// double-click a result word to save/unsave it without opening it
function onDblClick (e) {
  const a = e.target.closest('[data-w]')
  if (!a) return
  e.preventDefault()
  toggleSave(a.dataset.w)
}

function markSaved () {
  const saved = lists.saved()
  for (const a of body.querySelectorAll('[data-w]')) a.classList.toggle('saved', saved.has(a.dataset.w))
  for (const b of body.querySelectorAll('[data-blend]')) b.classList.toggle('saved', saved.has(b.dataset.blend))
}

function markSelected () {
  const w = store.get().w
  for (const a of body.querySelectorAll('.cloud a.sel')) a.classList.remove('sel')
  if (w) for (const a of body.querySelectorAll(`.cloud a[data-w="${CSS.escape(w)}"]`)) a.classList.add('sel')
}

