// Boot, routing, header controls and keyboard shortcuts.

import { loadLexicon, lex, fmt, idOf } from './lexicon.js'
import { call } from './engine.js'
import { store } from './state.js'
import { lists } from './lists.js'
import { toggleSave, addSeed, openCloud } from './actions.js'
import { $, isTyping, openPopover, fill } from './ui/dom.js'
import { mountFilters } from './ui/filters.js'
import { mountExplore, explore } from './ui/explore.js'
import { mountDetail } from './ui/detail.js'
import { mountCloud } from './ui/cloud.js'
import { mountLists } from './ui/lists-view.js'
import { renderActivePicker } from './ui/listpicker.js'

const ROUTES = ['explore', 'cloud', 'lists']
const THEMES = ['system', 'light', 'dark']

boot().catch(err => {
  console.error(err)
  $('#boot-status').textContent = 'failed'
  $('.boot-inner').append(Object.assign(document.createElement('p'), { className: 'fine', style: 'margin-top:16px;line-height:1.6', textContent: String(err.message || err) }))
})

async function boot () {
  const status = $('#boot-status')
  const t0 = performance.now()
  await Promise.all([loadLexicon(), call('init')])
  status.textContent = `${fmt.format(lex.N)} words`
  store.init()

  mountFilters($('#filters'))
  mountExplore($('#view-explore'))
  mountDetail($('#detail'))
  mountCloud($('#view-cloud'))
  mountLists($('#view-lists'))
  wireHeader()
  wireKeys()
  applyRoute()
  store.subscribe((s, ch) => { if (ch.has('route') || ch.has('w')) applyRoute(); if (ch.has('q') || ch.has('qm')) syncSearch() })
  syncSearch()

  const wait = Math.max(0, 350 - (performance.now() - t0))
  setTimeout(() => { $('#boot').classList.add('done'); setTimeout(() => $('#boot').remove(), 400) }, wait)

  // warm the engine's heavier assets while the user looks around
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1200))
  idle(() => { call('warm', 'vectors'); call('warm', 'phon') })
}

// ------------------------------------------------------------------ routing

function applyRoute () {
  const r = store.get().route
  $('#app').dataset.route = r
  for (const name of ROUTES) $(`#view-${name}`).hidden = name !== r
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.route === r) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  const w = store.get().w
  document.title = [w, r === 'explore' ? '' : r[0].toUpperCase() + r.slice(1), 'Wordable'].filter(Boolean).join(' · ')
}

function go (route) { store.set({ route }, { push: true }) }

// ------------------------------------------------------------------ header

function wireHeader () {
  for (const a of document.querySelectorAll('.nav a, .brand')) {
    a.addEventListener('click', e => { e.preventDefault(); go(a.dataset.route || 'explore') })
  }

  const q = $('#q')
  q.addEventListener('input', () => store.set({ q: q.value, ...(store.get().route !== 'explore' ? { route: 'explore' } : {}) }))
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (q.value) { q.value = ''; store.set({ q: '' }) } else q.blur() }
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); if (store.get().route !== 'explore') go('explore'); explore.focus() }
  })
  for (const b of document.querySelectorAll('#qm button')) {
    b.addEventListener('click', () => {
      const s = store.get()
      const qm = b.dataset.v
      // definition hits read best by relevance; word matches read best alphabetically
      const patch = { qm }
      if (qm === 'defs' && s.sort === 'az') Object.assign(patch, { sort: 'best', group: 'none' })
      if (qm !== 'defs' && s.qm === 'defs' && s.sort === 'best') Object.assign(patch, { sort: 'az', group: 'letter' })
      store.set(patch)
      q.focus()
    })
  }

  const saving = $('#saving-to')
  const pop = $('#pop-saving')
  const drawSaving = () => {
    fill(saving, 'Saving to ', Object.assign(document.createElement('b'), { textContent: lists.active().name }))
    $('#nav-lists-count').textContent = lists.saved().size ? String(lists.saved().size) : ''
  }
  saving.removeAttribute('popovertarget')
  saving.addEventListener('click', () => openPopover(pop, saving, renderActivePicker, { align: 'end' }))
  lists.subscribe(drawSaving)
  drawSaving()

  const theme = $('#theme')
  const drawTheme = () => {
    const t = document.documentElement.dataset.theme || 'system'
    theme.textContent = { system: 'Auto', light: 'Light', dark: 'Dark' }[t]
    theme.title = `Theme: ${t === 'system' ? 'follows your system' : t} — click to change`
  }
  theme.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'system'
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]
    if (next === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = next
    try { if (next === 'system') localStorage.removeItem('wordable.theme'); else localStorage.setItem('wordable.theme', next) } catch {}
    drawTheme()
  })
  drawTheme()
  $('#help-btn').addEventListener('click', () => $('#help').showModal())
}

function syncSearch () {
  const s = store.get()
  const q = $('#q')
  if (q.value !== s.q && document.activeElement !== q) q.value = s.q
  for (const b of document.querySelectorAll('#qm button')) b.setAttribute('aria-checked', String(b.dataset.v === s.qm))
  q.placeholder = s.qm === 'defs' ? 'Search definitions — e.g. light bright' : 'Search words — lu*, ?ex, /^[aeiou]/'
}

// ------------------------------------------------------------------ keyboard

function currentWord () {
  const s = store.get()
  if (s.w) return s.w
  if (s.route === 'explore') return explore.currentWord()
  return null
}

function wireKeys () {
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); return }
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return
    if (document.querySelector('dialog[open]')) return
    const s = store.get()
    const w = currentWord()
    switch (e.key) {
      case '/': e.preventDefault(); focusSearch(); break
      case '1': case '2': case '3': go(ROUTES[+e.key - 1]); break
      case 's': case 'S': if (w) toggleSave(w); break
      case 'c': case 'C': if (w && idOf(w) >= 0) openCloud(w); break
      case '+': case '=': if (w && idOf(w) >= 0) addSeed(w, 1); break
      case '-': case '_': if (w && idOf(w) >= 0) addSeed(w, -1); break
      case 'r': case 'R': if (s.route === 'explore') explore.random(); break
      case '[': history.back(); break
      case ']': history.forward(); break
      case 'g': case 'G': if (s.route === 'explore') cycle('group', ['letter', 'none', 'length', 'syl', 'freq', 'pos']); break
      case 'v': case 'V': if (s.route === 'explore') cycle('view', ['grid', 'list', 'type']); break
      case '?': $('#help').showModal(); break
      case 'Escape':
        if (document.querySelector(':popover-open')) return
        if (s.w) { store.set({ w: '' }, { push: true }); if (s.route === 'explore') explore.focus() }
        break
      default: return
    }
  })
}

function cycle (key, values) {
  const cur = store.get()[key]
  store.set({ [key]: values[(values.indexOf(cur) + 1) % values.length] })
}

function focusSearch () {
  const q = $('#q')
  q.focus()
  q.select()
}
