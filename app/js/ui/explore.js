// Explore: every word, virtualised. Grid (dense columns), List (receipt rows with definitions), Type (specimens).
// Rows are absolutely positioned and recycled, so 370k words scroll like 30.

import { store, filterOf, activeFilterCount } from '../state.js'
import { lex, idOf, firstGloss, onShard, metaLine, fmt, band, posShort } from '../lexicon.js'
import { latest, STALE, onProgress } from '../engine.js'
import { lists } from '../lists.js'
import { h, esc, fill } from './dom.js'
import { toggleSave } from '../actions.js'

const SIZES = {
  grid: { s: { col: 124, row: 26, font: 13 }, m: { col: 160, row: 32, font: 14 }, l: { col: 220, row: 42, font: 17 } },
  list: { s: { col: 400, row: 50 }, m: { col: 480, row: 58 }, l: { col: 620, row: 62 } },
  type: { s: { col: 230, row: 86, font: 24 }, m: { col: 320, row: 112, font: 32 }, l: { col: 460, row: 146, font: 46 } }
}
const SORTS = [
  ['az', 'A – Z'], ['za', 'Z – A'], ['common', 'Most common'], ['rare', 'Least common'], ['short', 'Shortest'],
  ['long', 'Longest'], ['syl', 'Syllables'], ['ending', 'Ending (rhyme order)'], ['random', 'Shuffled'], ['best', 'Best match']
]
const GROUPS = [['none', 'None'], ['letter', 'Letter'], ['length', 'Length'], ['syl', 'Syllables'], ['freq', 'Frequency'], ['pos', 'Type']]
const VIEWS = [['grid', 'Grid'], ['list', 'List'], ['type', 'Type']]
const HEAD_H = 58
const HEAD_H0 = 44
const PAD_TOP = 6

export const explore = { ids: new Uint32Array(0), groups: [], cursor: -1 }

let view
let pane
let inner
let sticky
let rail
let barTotal
let barStatus
let emptyEl
let cols = 1
let rowH = 32
let total = 0
let rowsTop = new Float64Array(0)
let rowsKind = new Uint8Array(0) // 0 = items, 1 = group header
let rowsStart = new Uint32Array(0)
let rowsEnd = new Uint32Array(0)
let rowsGroup = new Int32Array(0)
let rowCount = 0
const rendered = new Map()
let paintQueued = false
let lastWidth = 0
let queryInfo = { took: 0 }

export function mountExplore (el) {
  view = el
  const bar = h('div', { class: 'bar' })
  pane = h('div', { class: 'pane', id: 'results', tabindex: '0', role: 'listbox', 'aria-label': 'Words', 'aria-multiselectable': 'false' })
  inner = h('div', { class: 'pane-inner' })
  sticky = h('div', { class: 'sticky', 'aria-hidden': 'true' })
  rail = h('nav', { class: 'rail', 'aria-label': 'Jump to letter' })
  emptyEl = h('div', { class: 'empty', hidden: true })
  pane.append(inner, emptyEl)
  const wrap = h('div', { style: { position: 'relative', minHeight: '0', display: 'grid' } }, pane, sticky, rail)
  fill(el, bar, wrap)
  renderBar(bar)

  pane.addEventListener('scroll', schedulePaint, { passive: true })
  pane.addEventListener('click', onClick)
  pane.addEventListener('dblclick', onDblClick)
  pane.addEventListener('keydown', onKey)
  new ResizeObserver(() => {
    if (pane.clientWidth !== lastWidth) { lastWidth = pane.clientWidth; relayout(true) } else schedulePaint()
  }).observe(pane)

  store.subscribe((s, ch) => {
    if (['q', 'qm', 'len', 'syl', 'zipf', 'pos', 'inc', 'exc', 'hide', 'need', 'shape', 'shapeNot', 'saved', 'sort', 'group', 'seed'].some(k => ch.has(k))) runQuery(true)
    if (ch.has('view') || ch.has('size')) { renderBar(bar); relayout(false) }
    if (ch.has('sort') || ch.has('group')) renderBar(bar)
    if (ch.has('w')) { syncCursorToWord(); repaint() }
  })
  lists.subscribe(() => { if (store.get().saved !== 'any') runQuery(false); else repaint() })
  onShard(() => { if (store.get().view !== 'grid') repaint() })
  onProgress((p) => { if (p.what === 'definitions') setStatus(p.done < p.total ? `Loading definitions ${p.done}/${p.total}` : '') })
  runQuery(true)

  function renderBar (barEl) {
    const s = store.get()
    barTotal = h('span', { class: 'total' }, '—')
    barStatus = h('span', { class: 'status' })
    const sortSel = h('select', {
      'aria-label': 'Sort',
      // letter groups only make sense in alphabetical order
      onchange: e => { const v = e.target.value; store.set({ sort: v, ...(v !== 'az' && v !== 'za' && store.get().group === 'letter' ? { group: 'none' } : {}) }) }
    },
      SORTS.map(([v, l]) => h('option', { value: v, selected: s.sort === v }, l)))
    const groupSel = h('select', { 'aria-label': 'Group', onchange: e => store.set({ group: e.target.value }) },
      GROUPS.map(([v, l]) => h('option', { value: v, selected: s.group === v }, l)))
    fill(barEl, ...[
      h('span', null, barTotal, ' words'),
      barStatus,
      h('span', { class: 'spacer' }),
      h('label', { class: 'ctl' }, 'Sort', sortSel),
      s.sort === 'random' ? h('button', { class: 'link', title: 'Reshuffle', onclick: () => store.set({ seed: (Math.random() * 1e9) | 0 }) }, 'Reshuffle') : null,
      h('label', { class: 'ctl' }, 'Group', groupSel),
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' },
        VIEWS.map(([v, l]) => h('button', { role: 'radio', 'aria-checked': String(s.view === v), onclick: () => store.set({ view: v }) }, l))),
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Size' },
        ['s', 'm', 'l'].map(v => h('button', { role: 'radio', 'aria-checked': String(s.size === v), title: { s: 'Small', m: 'Medium', l: 'Large' }[v], onclick: () => store.set({ size: v }) }, v.toUpperCase()))),
      h('button', { class: 'link', title: 'Random word from these results (R)', onclick: () => explore.random() }, 'Random')
    ].filter(Boolean))
    updateTotal()
  }
}

function setStatus (text) { if (barStatus) barStatus.textContent = text }

function updateTotal () {
  if (!barTotal) return
  barTotal.textContent = fmt.format(explore.ids.length)
  const n = explore.ids.length
  if (!queryInfo.error) setStatus(n ? `${queryInfo.took < 1 ? '<1' : Math.round(queryInfo.took)} ms` : '')
}

// ------------------------------------------------------------------ query

async function runQuery (resetScroll) {
  const s = store.get()
  const f = { ...filterOf(s), sort: s.sort, group: s.group, seed: s.seed }
  if (s.saved !== 'any') {
    f.savedIds = [...lists.saved()].map(idOf).filter(i => i >= 0)
    f.savedKey = f.savedIds.join(',')
  }
  if (s.qm === 'defs' && s.q.trim()) setStatus('Searching definitions')
  const res = await latest('explore', 'query', f)
  if (res === STALE) return
  explore.ids = res.ids
  explore.groups = res.groups
  queryInfo = res
  if (res.error) setStatus(res.error)
  updateTotal()
  if (resetScroll) pane.scrollTop = 0
  syncCursorToWord()
  if (explore.cursor < 0 || explore.cursor >= res.ids.length) explore.cursor = res.ids.length ? 0 : -1
  relayout(!resetScroll)
  renderEmpty()
}

function renderEmpty () {
  const n = explore.ids.length
  emptyEl.hidden = n > 0
  if (n) return
  const s = store.get()
  const filters = activeFilterCount(s)
  fill(emptyEl,
    h('strong', null, 'No words match.'),
    s.q ? h('div', null, `Search “${s.q}” · ${s.qm === 'defs' ? 'in definitions' : s.qm}`) : null,
    filters ? h('div', null, `${filters} filter${filters > 1 ? 's' : ''} active`) : null,
    filters ? h('button', { class: 'btn', onclick: () => store.resetFilters() }, 'Clear filters') : null
  )
}

// ------------------------------------------------------------------ layout

function dims () {
  const s = store.get()
  return SIZES[s.view]?.[s.size] || SIZES.grid.m
}

function relayout (keepScroll) {
  const s = store.get()
  const d = dims()
  const avail = Math.max(200, pane.clientWidth - 2 * gutter() - 16)
  cols = Math.max(1, Math.floor(avail / d.col))
  rowH = d.row
  view.classList.remove('v-grid', 'v-list', 'v-type')
  view.classList.add('v-' + s.view)
  view.style.setProperty('--wsize', (d.font || 14) + 'px')
  view.style.setProperty('--tsize', (d.font || 30) + 'px')

  const anchorK = keepScroll ? firstVisibleK() : -1
  buildRows()
  inner.style.height = total + 'px'
  clearRendered()
  if (anchorK >= 0) scrollToK(anchorK, 'start')
  paint()
  renderRail()
}

function gutter () { return parseFloat(getComputedStyle(pane).getPropertyValue('--gutter')) || 20 }

function buildRows () {
  const n = explore.ids.length
  const groups = explore.groups
  const est = Math.ceil(n / cols) + groups.length + 2
  rowsTop = new Float64Array(est)
  rowsKind = new Uint8Array(est)
  rowsStart = new Uint32Array(est)
  rowsEnd = new Uint32Array(est)
  rowsGroup = new Int32Array(est)
  let r = 0
  let y = PAD_TOP
  const items = (start, end, g) => {
    for (let k = start; k < end; k += cols) {
      rowsTop[r] = y; rowsKind[r] = 0; rowsStart[r] = k; rowsEnd[r] = Math.min(k + cols, end); rowsGroup[r] = g; r++
      y += rowH
    }
  }
  if (groups.length) {
    groups.forEach((g, gi) => {
      rowsTop[r] = y; rowsKind[r] = 1; rowsStart[r] = g.start; rowsEnd[r] = g.start + g.count; rowsGroup[r] = gi; r++
      y += gi === 0 ? HEAD_H0 : HEAD_H
      items(g.start, g.start + g.count, gi)
    })
  } else {
    items(0, n, -1)
  }
  rowCount = r
  total = y + 48
}

// last row whose top <= y
function rowAt (y) {
  let lo = 0
  let hi = rowCount - 1
  if (hi < 0) return 0
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rowsTop[mid] <= y) lo = mid; else hi = mid - 1 }
  return lo
}

// item row containing position k
function rowOfK (k) {
  let lo = 0
  let hi = rowCount - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rowsStart[mid] <= k) lo = mid; else hi = mid - 1 }
  while (lo < rowCount && rowsKind[lo] === 1) lo++
  while (lo > 0 && rowsStart[lo] > k) lo--
  return lo
}

function rowHeight (r) { return (r + 1 < rowCount ? rowsTop[r + 1] : total - 48) - rowsTop[r] }

function firstVisibleK () {
  if (!rowCount || !explore.ids.length) return -1
  let r = rowAt(pane.scrollTop + 1)
  while (r < rowCount && rowsKind[r] === 1) r++
  return r < rowCount ? rowsStart[r] : -1
}

function scrollToK (k, mode = 'nearest') {
  if (!rowCount) return
  const r = rowOfK(k)
  const top = rowsTop[r]
  const bottom = top + rowHeight(r)
  const stickyH = explore.groups.length ? 32 : 0
  if (mode === 'start') { pane.scrollTop = Math.max(0, top - PAD_TOP - (explore.groups.length ? HEAD_H0 : 0)); return }
  if (top - stickyH < pane.scrollTop) pane.scrollTop = top - stickyH - 4
  else if (bottom > pane.scrollTop + pane.clientHeight) pane.scrollTop = bottom - pane.clientHeight + 4
}

// ------------------------------------------------------------------ paint

function schedulePaint () {
  if (paintQueued) return
  paintQueued = true
  requestAnimationFrame(() => { paintQueued = false; paint() })
}

function clearRendered () {
  for (const el of rendered.values()) el.remove()
  rendered.clear()
}

export function repaint () { clearRendered(); paint() }

function paint () {
  if (!rowCount) { clearRendered(); sticky.classList.remove('on'); return }
  const top = pane.scrollTop
  const hgt = pane.clientHeight || 800
  const over = Math.max(300, hgt * 0.5)
  const first = rowAt(Math.max(0, top - over))
  const last = rowAt(top + hgt + over)
  for (const [r, el] of rendered) if (r < first || r > last) { el.remove(); rendered.delete(r) }
  const frag = document.createDocumentFragment()
  for (let r = first; r <= last; r++) {
    if (rendered.has(r)) continue
    const el = makeRow(r)
    rendered.set(r, el)
    frag.append(el)
  }
  inner.append(frag)
  updateSticky(top)
  updateActiveDescendant()
}

function makeRow (r) {
  const el = document.createElement('div')
  el.className = 'row'
  el.style.transform = `translateY(${rowsTop[r]}px)`
  el.style.height = rowHeight(r) + 'px'
  if (rowsKind[r] === 1) {
    const g = explore.groups[rowsGroup[r]]
    el.innerHTML = `<div class="ghead"><b>${esc(g.label)}</b><span class="leader"></span><span>${fmt.format(g.count)}</span></div>`
    el.setAttribute('role', 'presentation')
    return el
  }
  el.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`
  el.setAttribute('role', 'presentation')
  const s = store.get()
  const saved = lists.saved()
  const n = explore.ids.length
  let html = ''
  for (let k = rowsStart[r]; k < rowsEnd[r]; k++) {
    const id = explore.ids[k]
    const w = lex.words[id]
    const cls = 'w' + (saved.has(w) ? ' saved' : '') + (s.w === w ? ' sel' : '') + (k === explore.cursor ? ' cur' : '')
    html += `<div class="${cls}" id="w-${id}" role="option" aria-selected="${s.w === w}" aria-setsize="${n}" aria-posinset="${k + 1}" data-k="${k}" title="Double-click to save"><span class="t">${w}</span>${extra(id, w, s.view)}</div>`
  }
  el.innerHTML = html
  return el
}

function extra (id, w, v) {
  if (v === 'list') {
    const g = firstGloss(w)
    return `<span class="leader"></span><span class="m">${esc(metaLine(id))}</span><span class="g">${g ? esc(g) : ''}</span>`
  }
  if (v === 'type') {
    const bits = [lex.syl[id] + ' syl', posShort(lex.pos[id]), band(lex.zipf[id])].filter(Boolean)
    return `<span class="m">${esc(bits.join(' · '))}</span>`
  }
  return ''
}

function updateSticky (top) {
  if (!explore.groups.length) { sticky.classList.remove('on'); return }
  const r = rowAt(top + 2)
  const g = explore.groups[rowsGroup[r]]
  const show = top > HEAD_H0 && g
  sticky.classList.toggle('on', !!show)
  if (show) sticky.textContent = `${g.label}  ·  ${fmt.format(g.count)}`
}

function updateActiveDescendant () {
  const k = explore.cursor
  const id = k >= 0 ? explore.ids[k] : -1
  if (id >= 0 && document.getElementById('w-' + id)) pane.setAttribute('aria-activedescendant', 'w-' + id)
  else pane.removeAttribute('aria-activedescendant')
}

function renderRail () {
  const s = store.get()
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('')
  const byGroup = s.group === 'letter'
  const alpha = s.group === 'none' && (s.sort === 'az' || s.sort === 'za')
  if ((!byGroup && !alpha) || explore.ids.length < 200) { rail.hidden = true; return }
  rail.hidden = false
  const present = new Set()
  if (byGroup) for (const g of explore.groups) present.add(g.label.toLowerCase())
  else for (const L of letters) if (firstKForLetter(L) >= 0) present.add(L)
  fill(rail, ...letters.map(L => h('button', {
    disabled: !present.has(L),
    'aria-label': `Jump to ${L.toUpperCase()}`,
    onclick: () => jumpLetter(L)
  }, L)))
}

function firstKForLetter (L) {
  const ids = explore.ids
  const words = lex.words
  const desc = store.get().sort === 'za'
  let lo = 0
  let hi = ids.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const c = words[ids[mid]][0]
    if (desc ? c > L : c < L) lo = mid + 1; else hi = mid
  }
  return lo < ids.length && words[ids[lo]][0] === L ? lo : -1
}

function jumpLetter (L) {
  const s = store.get()
  if (s.group === 'letter') {
    const gi = explore.groups.findIndex(g => g.label.toLowerCase() === L)
    if (gi < 0) return
    for (let r = 0; r < rowCount; r++) if (rowsKind[r] === 1 && rowsGroup[r] === gi) { pane.scrollTop = rowsTop[r] - PAD_TOP; break }
    explore.cursor = explore.groups[gi].start
  } else {
    const k = firstKForLetter(L)
    if (k < 0) return
    scrollToK(k, 'start')
    explore.cursor = k
  }
  repaint()
  pane.focus({ preventScroll: true })
}

// ------------------------------------------------------------------ interaction

function onClick (e) {
  const item = e.target.closest('.w')
  if (!item) return
  const k = +item.dataset.k
  const w = lex.words[explore.ids[k]]
  explore.cursor = k
  store.set({ w }, { push: true })
}

// double-click (or double-tap) saves/unsaves without leaving the list
function onDblClick (e) {
  const item = e.target.closest('.w')
  if (!item) return
  e.preventDefault()
  toggleSave(lex.words[explore.ids[+item.dataset.k]])
}


function syncCursorToWord () {
  const w = store.get().w
  if (!w) return
  const id = idOf(w)
  if (id < 0) return
  const cur = explore.cursor
  if (cur >= 0 && explore.ids[cur] === id) return
  const k = explore.ids.indexOf(id)
  if (k >= 0) explore.cursor = k
}

function moveCursor (k, follow) {
  const n = explore.ids.length
  if (!n) return
  k = Math.max(0, Math.min(n - 1, k))
  explore.cursor = k
  scrollToK(k)
  if (follow) store.set({ w: lex.words[explore.ids[k]] })
  repaint()
}

function verticalTarget (k, dir) {
  const r = rowOfK(k)
  const col = k - rowsStart[r]
  let t = r + dir
  while (t >= 0 && t < rowCount && rowsKind[t] === 1) t += dir
  if (t < 0 || t >= rowCount) return k
  return Math.min(rowsStart[t] + col, rowsEnd[t] - 1)
}

function onKey (e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const n = explore.ids.length
  if (!n) return
  const k = explore.cursor < 0 ? 0 : explore.cursor
  const follow = !!store.get().w
  const page = Math.max(1, Math.floor(pane.clientHeight / rowH) - 1)
  let next = null
  switch (e.key) {
    case 'ArrowRight': next = k + 1; break
    case 'ArrowLeft': next = k - 1; break
    case 'ArrowDown': next = verticalTarget(k, 1); break
    case 'ArrowUp': next = verticalTarget(k, -1); break
    case 'PageDown': next = k + page * cols; break
    case 'PageUp': next = k - page * cols; break
    case 'Home': next = 0; break
    case 'End': next = n - 1; break
    case 'Enter': store.set({ w: lex.words[explore.ids[k]] }, { push: true }); e.preventDefault(); return
    default: return
  }
  e.preventDefault()
  moveCursor(next, follow)
}

explore.focus = () => pane?.focus({ preventScroll: true })
explore.currentWord = () => {
  const k = explore.cursor
  return k >= 0 && k < explore.ids.length ? lex.words[explore.ids[k]] : null
}
explore.random = () => {
  const n = explore.ids.length
  if (!n) return
  const k = Math.floor(Math.random() * n)
  explore.cursor = k
  scrollToK(k, 'start')
  store.set({ w: lex.words[explore.ids[k]] }, { push: true })
  repaint()
}
