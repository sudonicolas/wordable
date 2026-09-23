// Filter bar: presets plus one compact "LABEL value" cell per filter, each opening a popover editor.
// Filters are global: they shape Explore, the Cloud, and the neighbours in the word panel.

import { store, DEFAULTS, LIMITS, SHAPE, FILTER_KEYS, activeFilterCount } from '../state.js'
import { F, BANDS } from '../lexicon.js'
import { h, openPopover, fill } from './dom.js'

const CLEAN = F.proper | F.abbr | F.infl | F.taxon

export const PRESETS = [
  { id: 'all', label: 'All', title: 'Every word in the list', patch: {} },
  { id: 'dict', label: 'Dictionary', title: 'Defined words, no names, abbreviations, inflections or Latin taxa', patch: { need: F.def, hide: CLEAN } },
  { id: 'everyday', label: 'Everyday', title: 'Words people actually use', patch: { zipf: [35, 80], hide: F.proper | F.abbr | F.infl } },
  {
    id: 'brand',
    label: 'Brandable',
    title: '4–9 letters, 1–3 syllables, pronounceable, defined; no names, inflections, archaic, offensive or negated words',
    patch: { len: [4, 9], syl: [1, 3], need: F.def, hide: CLEAN | F.archaic | F.sensitive | F.negated, shape: SHAPE.pronounceable }
  }
]

const FREQ_CHIPS = [
  ['Any', [0, 80]],
  ['Very common', [50, 80]],
  ['Common +', [40, 80]],
  ['Familiar +', [30, 80]],
  ['Uncommon', [20, 29]],
  ['Rare', [1, 19]],
  ['Known', [1, 80]],
  ['Unattested', [0, 0]]
]

const HIDE_OPTS = [
  ['proper', 'Names & places'],
  ['abbr', 'Abbreviations'],
  ['infl', 'Inflections', 'plurals, -ed, -ing'],
  ['taxon', 'Latin taxa', 'genus & family names'],
  ['archaic', 'Archaic & obsolete'],
  ['sensitive', 'Offensive & vulgar'],
  ['negated', 'Negations', 'un-, non-, -less'],
  ['variant', 'UK/US variants']
]
const NEED_OPTS = [
  ['def', 'Has a definition'],
  ['pron', 'Has a pronunciation'],
  ['vec', 'In the meaning engine']
]
const SHAPE_OPTS = [
  ['pronounceable', 'Pronounceable', 'no awkward consonant clusters'],
  ['isogram', 'No repeated letters'],
  ['vowelStart', 'Starts with a vowel'],
  ['vowelEnd', 'Ends with a vowel'],
  ['palindrome', 'Palindrome'],
  ['double', 'Has a double letter']
]
const POS_OPTS = [[1, 'Noun'], [2, 'Verb'], [4, 'Adjective'], [8, 'Adverb']]

let root
let pop

export function mountFilters (el) {
  root = el
  pop = h('div', { popover: '', class: 'pop', id: 'pop-filter' })
  document.body.append(pop)
  store.subscribe((s, changed) => {
    if (FILTER_KEYS.some(k => changed.has(k))) render()
    if (pop.matches(':popover-open') && pop._cell && !changed.has('q')) refreshPopover()
  })
  render()
}

function presetActive (p) {
  const s = store.get()
  const want = { ...DEFAULTS, ...p.patch }
  return FILTER_KEYS.every(k => k === 'q' || k === 'qm' || JSON.stringify(s[k]) === JSON.stringify(want[k]))
}

export function applyPreset (id) {
  const p = PRESETS.find(x => x.id === id)
  if (p) store.resetFilters(p.patch)
}

function rangeText ([a, b], [lo, hi], unit = '') {
  if (a <= lo && b >= hi) return 'any'
  if (a === b) return `${a}${unit}`
  if (a <= lo) return `≤ ${b}${unit}`
  if (b >= hi) return `≥ ${a}${unit}`
  return `${a}–${b}${unit}`
}

function freqText (z) {
  const chip = FREQ_CHIPS.find(c => c[1][0] === z[0] && c[1][1] === z[1])
  if (chip) return chip[0] === 'Any' ? 'any' : chip[0].replace(' +', '+')
  return `${(z[0] / 10).toFixed(1)}–${(z[1] / 10).toFixed(1)}`
}

const CELLS = [
  { id: 'len', label: 'Length', value: s => rangeText(s.len, LIMITS.len), on: s => rangeText(s.len, LIMITS.len) !== 'any', edit: editRange('len', 'Letters', LIMITS.len, [['≤ 5', [1, 5]], ['4–6', [4, 6]], ['5–8', [5, 8]], ['6–10', [6, 10]], ['Any', LIMITS.len]]) },
  { id: 'syl', label: 'Syllables', value: s => rangeText(s.syl, LIMITS.syl), on: s => rangeText(s.syl, LIMITS.syl) !== 'any', edit: editRange('syl', 'Syllables', LIMITS.syl, [['1', [1, 1]], ['2', [2, 2]], ['3', [3, 3]], ['≤ 2', [1, 2]], ['≤ 3', [1, 3]], ['Any', LIMITS.syl]]) },
  { id: 'zipf', label: 'Frequency', value: s => freqText(s.zipf), on: s => freqText(s.zipf) !== 'any', edit: editFreq },
  { id: 'pos', label: 'Type', value: s => (s.pos ? POS_OPTS.filter(o => s.pos & o[0]).map(o => o[1].slice(0, 4).toLowerCase() + '.').join(' ') : 'any'), on: s => !!s.pos, edit: editPos },
  { id: 'letters', label: 'Letters', value: s => [s.inc && `+${s.inc}`, s.exc && `−${s.exc}`].filter(Boolean).join(' ') || 'any', on: s => !!(s.inc || s.exc), edit: editLetters },
  { id: 'shape', label: 'Shape', value: s => { const n = popcount(s.shape) + popcount(s.shapeNot); return n ? (n === 1 ? shapeName(s) : `${n} rules`) : 'any' }, on: s => !!(s.shape || s.shapeNot), edit: editShape },
  { id: 'clean', label: 'Hide', value: s => { const n = popcount(s.hide) + popcount(s.need); return n ? `${n} rule${n > 1 ? 's' : ''}` : 'nothing' }, on: s => !!(s.hide || s.need), edit: editClean },
  { id: 'saved', label: 'Saved', value: s => ({ any: 'any', only: 'only saved', hide: 'hide saved' })[s.saved] || 'any', on: s => s.saved !== 'any', edit: editSaved }
]

function popcount (m) { let n = 0; while (m) { n += m & 1; m >>>= 1 } return n }
function shapeName (s) {
  const o = SHAPE_OPTS.find(o => s.shape & SHAPE[o[0]])
  if (o) return o[1]
  return s.shapeNot & SHAPE.double ? 'No double letter' : 'custom'
}

function render () {
  const s = store.get()
  const presets = h('div', { class: 'seg presets', role: 'radiogroup', 'aria-label': 'Presets' },
    PRESETS.map(p => h('button', { role: 'radio', 'aria-checked': String(presetActive(p)), title: p.title, onclick: () => applyPreset(p.id) }, p.label)))
  const cells = CELLS.map(c => {
    const btn = h('button', { class: 'fcell' + (c.on(s) ? ' on' : ''), 'aria-haspopup': 'dialog', 'aria-expanded': 'false', dataset: { cell: c.id } },
      c.label, h('b', null, c.value(s)))
    btn.addEventListener('click', () => openCell(c, btn))
    return btn
  })
  const n = activeFilterCount(s)
  fill(root, presets, ...cells)
  if (n) root.append(h('button', { class: 'freset', onclick: () => store.resetFilters(), title: 'Clear all filters' }, `Reset ${n}`))
}

function openCell (cell, btn) {
  openPopover(pop, btn, (p) => { p._cell = cell; cell.edit(p) })
}

function refreshPopover () {
  const cell = pop._cell
  const btn = root.querySelector(`[data-cell="${cell.id}"]`)
  const active = document.activeElement
  const activeName = active && pop.contains(active) ? active.name || active.dataset.k : null
  if (active && pop.contains(active) && active.tagName === 'INPUT' && active.type !== 'checkbox' && active.type !== 'radio') return
  cell.edit(pop)
  if (btn) pop._anchor = btn
  if (activeName) pop.querySelector(`[name="${activeName}"], [data-k="${activeName}"]`)?.focus({ preventScroll: true })
}

// ------------------------------------------------------------------ editors

function editRange (key, noun, [lo, hi], chips) {
  return (p) => {
    const s = store.get()
    const [a, b] = s[key]
    const clamp = v => Math.max(lo, Math.min(hi, v | 0))
    const minI = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: lo, max: hi, value: a, name: key + '-min', 'aria-label': `Minimum ${noun.toLowerCase()}` })
    const maxI = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: lo, max: hi, value: b, name: key + '-max', 'aria-label': `Maximum ${noun.toLowerCase()}` })
    const apply = () => {
      let x = clamp(minI.value || lo)
      let y = clamp(maxI.value || hi)
      if (x > y) [x, y] = [y, x]
      store.set({ [key]: [x, y] })
    }
    minI.addEventListener('input', apply)
    maxI.addEventListener('input', apply)
    fill(p,
      h('h3', null, noun),
      h('div', { class: 'range' }, minI, h('span', { class: 'muted' }, 'to'), maxI),
      h('div', { class: 'fchips', style: { marginTop: '12px' } },
        chips.map(([label, r]) => h('button', { 'aria-pressed': String(a === r[0] && b === r[1]), onclick: () => store.set({ [key]: r }) }, label)))
    )
  }
}

function editFreq (p) {
  const z = store.get().zipf
  const minI = h('input', { class: 'field', type: 'number', step: '0.1', min: 0, max: 8, value: (z[0] / 10).toFixed(1), name: 'z-min', 'aria-label': 'Minimum Zipf frequency' })
  const maxI = h('input', { class: 'field', type: 'number', step: '0.1', min: 0, max: 8, value: (z[1] / 10).toFixed(1), name: 'z-max', 'aria-label': 'Maximum Zipf frequency' })
  const apply = () => {
    let a = Math.round(Math.max(0, Math.min(8, +minI.value || 0)) * 10)
    let b = Math.round(Math.max(0, Math.min(8, maxI.value === '' ? 8 : +maxI.value)) * 10)
    if (a > b) [a, b] = [b, a]
    store.set({ zipf: [a, b] })
  }
  minI.addEventListener('input', apply)
  maxI.addEventListener('input', apply)
  fill(p,
    h('h3', null, 'Frequency'),
    h('div', { class: 'fchips' }, FREQ_CHIPS.map(([label, r]) => h('button', { 'aria-pressed': String(z[0] === r[0] && z[1] === r[1]), onclick: () => store.set({ zipf: r }) }, label))),
    h('hr', { class: 'rule' }),
    h('h3', null, 'Zipf scale'),
    h('div', { class: 'range' }, minI, h('span', { class: 'muted' }, 'to'), maxI),
    h('p', { class: 'fine', style: { marginTop: '10px', lineHeight: '1.6' } },
      'Zipf = log10 of uses per billion words. ', BANDS.slice(0, 5).map(b => `${b.label} ≥ ${(b.min / 10).toFixed(1)}`).join(' · '), '. 0 = not in the frequency corpus.')
  )
}

function editPos (p) {
  const m = store.get().pos
  fill(p,
    h('h3', null, 'Part of speech — any of'),
    POS_OPTS.map(([bit, label]) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!(m & bit), 'data-k': 'pos' + bit, onchange: e => store.set({ pos: e.target.checked ? store.get().pos | bit : store.get().pos & ~bit }) }), label)),
    h('p', { class: 'fine', style: { marginTop: '8px' } }, 'From WordNet and Wiktionary; inflected forms inherit their base word’s type.')
  )
}

function editLetters (p) {
  const s = store.get()
  const inc = h('input', { class: 'field mono', value: s.inc, name: 'inc', placeholder: 'e.g. xz', autocomplete: 'off', spellcheck: 'false' })
  const exc = h('input', { class: 'field mono', value: s.exc, name: 'exc', placeholder: 'e.g. qj', autocomplete: 'off', spellcheck: 'false' })
  const clean = v => [...new Set(v.toLowerCase().replace(/[^a-z]/g, ''))].join('')
  inc.addEventListener('input', () => store.set({ inc: clean(inc.value) }))
  exc.addEventListener('input', () => store.set({ exc: clean(exc.value) }))
  fill(p,
    h('h3', null, 'Must contain all of'), inc,
    h('h3', { style: { marginTop: '14px' } }, 'Must not contain any of'), exc
  )
}

function editShape (p) {
  const s = store.get()
  fill(p,
    h('h3', null, 'Shape'),
    SHAPE_OPTS.map(([k, label, hint]) => checkRow(label, hint, !!(s.shape & SHAPE[k]), on => {
      const cur = store.get()
      store.set({ shape: on ? cur.shape | SHAPE[k] : cur.shape & ~SHAPE[k], shapeNot: on ? cur.shapeNot & ~SHAPE[k] : cur.shapeNot })
    }, 'shape-' + k)),
    checkRow('No double letters', '', !!(s.shapeNot & SHAPE.double), on => {
      const cur = store.get()
      store.set({ shapeNot: on ? cur.shapeNot | SHAPE.double : cur.shapeNot & ~SHAPE.double, shape: on ? cur.shape & ~SHAPE.double : cur.shape })
    }, 'shape-nodouble')
  )
}

function editClean (p) {
  const s = store.get()
  fill(p,
    h('h3', null, 'Hide'),
    HIDE_OPTS.map(([k, label, hint]) => checkRow(label, hint, !!(s.hide & F[k]), on => {
      const cur = store.get().hide
      store.set({ hide: on ? cur | F[k] : cur & ~F[k] })
    }, 'hide-' + k)),
    h('hr', { class: 'rule' }),
    h('h3', null, 'Require'),
    NEED_OPTS.map(([k, label]) => checkRow(label, '', !!(s.need & F[k]), on => {
      const cur = store.get().need
      store.set({ need: on ? cur | F[k] : cur & ~F[k] })
    }, 'need-' + k))
  )
}

function editSaved (p) {
  const v = store.get().saved
  fill(p,
    h('h3', null, 'Saved words'),
    [['any', 'Show all'], ['only', 'Only saved'], ['hide', 'Hide saved']].map(([k, label]) =>
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'saved', checked: v === k, onchange: () => store.set({ saved: k }) }), label))
  )
}

function checkRow (label, hint, checked, onchange, k) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked, 'data-k': k, onchange: e => onchange(e.target.checked) }),
    label, hint ? h('span', { class: 'muted' }, hint) : null)
}
