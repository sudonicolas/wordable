// Lists: shortlists per project. Reorder by drag (or Alt+↑/↓), rate, annotate, compare as specimens, export.

import { store } from '../state.js'
import { lex, idOf, firstGloss, onShard, loadShard, band, fmt } from '../lexicon.js'
import { lists } from '../lists.js'
import { selectWord } from '../actions.js'
import { h, toast, copy, download, fill } from './dom.js'

const SORTS = [['manual', 'Manual'], ['added', 'Newest'], ['az', 'A – Z'], ['len', 'Length'], ['stars', 'Rating']]
const PREF = 'wordable.listPrefs'

let root
let prefs = loadPrefs()

function loadPrefs () {
  try { return { sort: 'manual', view: 'rows', ...JSON.parse(localStorage.getItem(PREF) || '{}') } } catch { return { sort: 'manual', view: 'rows' } }
}
function setPref (patch) {
  prefs = { ...prefs, ...patch }
  try { localStorage.setItem(PREF, JSON.stringify(prefs)) } catch {}
  render()
}

export function mountLists (el) {
  root = el
  store.subscribe((s, ch) => { if (s.route === 'lists' && (ch.has('route') || ch.has('list') || ch.has('w'))) render() })
  lists.subscribe(() => render())
  onShard(() => { if (store.get().route === 'lists') refreshGlosses() })
  if (store.get().route === 'lists') render()
}

function current () {
  return lists.get(store.get().list) || lists.active()
}

function render () {
  if (store.get().route !== 'lists') return
  const focusedNote = document.activeElement?.closest?.('.items li')?.dataset.w
  if (focusedNote && document.activeElement.matches('input.note')) return // don't clobber typing
  const l = current()
  fill(root, h('div', { class: 'lists' }, index(l), main(l)))
}

function index (cur) {
  const input = h('input', { class: 'field', placeholder: 'New list name', 'aria-label': 'New list name' })
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true })
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]
    if (!f) return
    try { const n = lists.importAll(await f.text()); toast(`Imported ${n} word${n === 1 ? '' : 's'}`) } catch (e) { toast(e.message) }
    fileIn.value = ''
  })
  return h('aside', { class: 'lists-index' },
    h('h3', { class: 'label' }, 'Lists'),
    h('ul', null, lists.all().map(l => h('li', null, h('button', {
      'aria-current': String(l.id === cur.id),
      onclick: () => store.set({ list: l.id })
    }, l.name, l.id === lists.active().id ? h('span', { class: 'act', title: 'New saves go here' }, 'saving') : null, h('span', { class: 'leader' }), h('span', { class: 'n' }, String(l.items.length)))))),
    h('form', { class: 'new', onsubmit: e => { e.preventDefault(); const l = lists.create(input.value); store.set({ list: l.id }) } },
      input, h('button', { class: 'btn', type: 'submit' }, 'New list')),
    h('div', { class: 'io' },
      h('button', { onclick: () => download(`wordable-lists-${new Date().toISOString().slice(0, 10)}.json`, lists.exportAll(), 'application/json') }, 'Back up all'),
      h('button', { onclick: () => fileIn.click() }, 'Restore'), fileIn)
  )
}

function sorted (l) {
  const items = l.items.map((it, idx) => ({ ...it, idx }))
  switch (prefs.sort) {
    case 'added': return items.sort((a, b) => b.t - a.t)
    case 'az': return items.sort((a, b) => a.w.localeCompare(b.w))
    case 'len': return items.sort((a, b) => a.w.length - b.w.length || a.w.localeCompare(b.w))
    case 'stars': return items.sort((a, b) => (b.stars || 0) - (a.stars || 0) || a.idx - b.idx)
    default: return items
  }
}

function main (l) {
  const title = h('input', { value: l.name, 'aria-label': 'List name', spellcheck: 'false' })
  title.addEventListener('change', () => lists.rename(l.id, title.value))
  title.addEventListener('keydown', e => { if (e.key === 'Enter') title.blur() })
  const isActive = l.id === lists.active().id
  const items = sorted(l)
  const created = new Date(l.created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

  const exportMenu = h('select', { 'aria-label': 'Export', onchange: e => { exportAs(l, e.target.value); e.target.value = '' } },
    h('option', { value: '' }, 'Export'), h('option', { value: 'txt' }, 'Text (.txt)'), h('option', { value: 'csv' }, 'Spreadsheet (.csv)'), h('option', { value: 'json' }, 'JSON (.json)'))

  const paste = h('textarea', { class: 'field', rows: 3, placeholder: 'Paste or type words — one per line or comma-separated — including your own coinages', 'aria-label': 'Add words to this list' })
  const pasteForm = h('form', { class: 'paste', onsubmit: e => {
    e.preventDefault()
    const ws = paste.value.toLowerCase().split(/[\s,;]+/).map(w => w.replace(/[^a-z-]/g, '')).filter(Boolean)
    const n = lists.addMany(ws, l.id)
    toast(`Added ${n} word${n === 1 ? '' : 's'}`)
  } }, paste, h('div', null, h('button', { class: 'btn', type: 'submit' }, 'Add words')))

  return h('section', { class: 'list-main' },
    h('div', { class: 'list-title' }, title,
      h('button', { class: 'btn' + (isActive ? ' primary' : ''), disabled: isActive, title: 'Words you save (S) go to this list', onclick: () => lists.setActive(l.id) }, isActive ? 'Saving here' : 'Save here')),
    h('div', { class: 'list-meta label' }, h('span', null, `${fmt.format(l.items.length)} word${l.items.length === 1 ? '' : 's'}`), h('span', null, `Created ${created}`)),
    h('div', { class: 'list-bar' },
      h('span', { class: 'seg', role: 'radiogroup', 'aria-label': 'Sort' }, SORTS.map(([v, lab]) => h('button', { role: 'radio', 'aria-checked': String(prefs.sort === v), onclick: () => setPref({ sort: v }) }, lab))),
      h('span', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' }, [['rows', 'Rows'], ['spec', 'Specimen']].map(([v, lab]) => h('button', { role: 'radio', 'aria-checked': String(prefs.view === v), onclick: () => setPref({ view: v }) }, lab))),
      h('span', { class: 'spacer' }),
      l.items.length ? h('button', { class: 'link', onclick: () => cloudFrom(l) }, 'Cloud from list') : null,
      l.items.length ? h('button', { class: 'link', onclick: () => copy(l.items.map(it => it.w).join('\n'), `Copied ${l.items.length} words`) }, 'Copy') : null,
      l.items.length ? exportMenu : null,
      l.items.length ? h('button', { class: 'link', onclick: () => window.print(), title: 'Print this list' }, 'Print') : null,
      l.items.length ? h('button', { class: 'link', onclick: () => { const items = lists.clear(l.id); toast('List cleared', { label: 'Undo', run: () => lists.setItems(l.id, items) }) } }, 'Clear') : null,
      h('button', { class: 'link', onclick: () => { const r = lists.remove(l.id); store.set({ list: '' }); toast(`Deleted “${l.name}”`, { label: 'Undo', run: () => lists.restore(r) }) } }, 'Delete')),
    items.length
      ? (prefs.view === 'spec' ? specimens(items) : rows(l, items))
      : h('div', { class: 'empty', style: { paddingLeft: 0 } }, h('strong', null, 'Nothing saved yet.'), 'Press S on any word, double-click it, or paste words below.'),
    pasteForm
  )
}

function rows (l, items) {
  const manual = prefs.sort === 'manual'
  const ul = h('ul', { class: 'items' })
  let dragFrom = -1
  for (const it of items) {
    const id = idOf(it.w)
    const gloss = id >= 0 ? firstGloss(it.w) : 'coined'
    const note = h('input', { class: 'note', value: it.note || '', placeholder: 'Add a note', 'aria-label': `Note for ${it.w}` })
    let t = 0
    note.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => lists.update(it.w, { note: note.value }, l.id), 300) })
    note.addEventListener('blur', () => { clearTimeout(t); lists.update(it.w, { note: note.value }, l.id) })
    const stars = h('span', { class: 'stars', role: 'group', 'aria-label': 'Rating' }, [1, 2, 3].map(n => h('button', {
      class: (it.stars || 0) >= n ? 'on' : '',
      'aria-label': `${n} star${n > 1 ? 's' : ''}`,
      'aria-pressed': String((it.stars || 0) >= n),
      onclick: () => lists.update(it.w, { stars: it.stars === n ? 0 : n }, l.id)
    }, '★')))
    const li = h('li', { 'data-w': it.w, 'data-idx': it.idx, draggable: manual ? 'true' : 'false', tabindex: '-1' },
      h('span', { class: 'handle', title: manual ? 'Drag to reorder (or Alt+↑/↓)' : 'Switch to Manual sort to reorder', 'aria-hidden': 'true' }, manual ? '⋮⋮' : '·'),
      h('span', { class: 'word', tabindex: '0', role: 'button', onclick: () => selectWord(it.w), onkeydown: e => {
        if (e.key === 'Enter') selectWord(it.w)
        if (manual && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          const to = Math.max(0, Math.min(l.items.length - 1, it.idx + (e.key === 'ArrowUp' ? -1 : 1)))
          lists.move(l.id, it.idx, to)
          requestAnimationFrame(() => root.querySelector(`.items li[data-idx="${to}"] .word`)?.focus())
        }
      } }, it.w, h('small', { 'data-gloss': it.w }, gloss || '')),
      note,
      h('span', { class: 'm' }, id >= 0 ? `${it.w.length} · ${lex.syl[id]} syl · ${band(lex.zipf[id])}` : `${it.w.length} · coined`),
      h('span', null, stars, h('button', { class: 'rm', title: 'Remove', 'aria-label': `Remove ${it.w}`, onclick: () => {
        const r = lists.removeWord(it.w, l.id)
        toast(`Removed “${it.w}”`, { label: 'Undo', run: () => lists.restoreWord(r) })
      } }, '×')))
    if (manual) {
      li.addEventListener('dragstart', e => { dragFrom = it.idx; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.w) })
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); for (const x of ul.children) x.classList.remove('drag-over') })
      li.addEventListener('dragover', e => { e.preventDefault(); for (const x of ul.children) x.classList.toggle('drag-over', x === li) })
      li.addEventListener('drop', e => { e.preventDefault(); if (dragFrom >= 0) lists.move(l.id, dragFrom, it.idx); dragFrom = -1 })
    }
    ul.append(li)
  }
  return ul
}

function specimens (items) {
  return h('ul', { class: 'specimens' }, items.map(it => {
    const id = idOf(it.w)
    const t = it.w.charAt(0).toUpperCase() + it.w.slice(1)
    return h('li', { onclick: () => selectWord(it.w), tabindex: '0', onkeydown: e => { if (e.key === 'Enter') selectWord(it.w) } },
      h('div', { class: 'big' }, t),
      h('div', { class: 'alt' }, h('span', null, it.w), h('span', null, it.w), h('span', { style: { fontFamily: 'ui-serif, Georgia, serif', fontStyle: 'italic' } }, t)),
      h('div', { class: 'm label' }, id >= 0 ? `${it.w.length} letters · ${lex.syl[id]} syl · ${band(lex.zipf[id])}` : `${it.w.length} letters · coined`, it.stars ? ` · ${'★'.repeat(it.stars)}` : ''),
      it.note ? h('div', { class: 'fine', style: { marginTop: '6px', color: 'var(--fg-2)' } }, it.note) : null)
  }))
}

function refreshGlosses () {
  for (const el of root.querySelectorAll('[data-gloss]')) {
    const w = el.dataset.gloss
    if (!el.textContent && idOf(w) >= 0) el.textContent = firstGloss(w) || ''
  }
}

function cloudFrom (l) {
  const seeds = l.items.map(it => it.w).filter(w => idOf(w) >= 0).slice(0, 10).map(w => ({ w, sign: 1 }))
  if (!seeds.length) { toast('No dictionary words in this list'); return }
  store.set({ route: 'cloud', seeds }, { push: true })
}

async function exportAs (l, kind) {
  if (!kind) return
  await Promise.all([...new Set(l.items.map(it => it.w[0]))].map(loadShard))
  const safe = l.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'list'
  if (kind === 'txt') download(`${safe}.txt`, l.items.map(it => it.w).join('\n') + '\n')
  if (kind === 'json') download(`${safe}.json`, JSON.stringify(l, null, 2), 'application/json')
  if (kind === 'csv') {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [['word', 'note', 'rating', 'letters', 'syllables', 'frequency', 'definition', 'added'].join(',')]
    for (const it of l.items) {
      const id = idOf(it.w)
      lines.push([q(it.w), q(it.note), it.stars || 0, it.w.length, id >= 0 ? lex.syl[id] : '', q(id >= 0 ? band(lex.zipf[id]) : 'coined'), q(id >= 0 ? firstGloss(it.w) || '' : ''), q(new Date(it.t).toISOString())].join(','))
    }
    download(`${safe}.csv`, lines.join('\n') + '\n', 'text/csv')
  }
}
