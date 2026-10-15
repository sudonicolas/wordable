// Word panel: the "receipt" for one word — facts, definitions, dictionary relations, computed neighbours.

import { store, filterOf } from '../state.js'
import { lex, F, idOf, entry, fmt, band, posList, POS_LONG, POS_SHORT } from '../lexicon.js'
import { latest, STALE } from '../engine.js'
import { lists } from '../lists.js'
import { toggleSave, addSeed, openCloud, selectWord } from '../actions.js'
import { h, copy, openPopover, fill } from './dom.js'
import { renderMembership } from './listpicker.js'

const SHOW_SENSES = 6
const WARN_TAGS = new Set(['vulgar', 'derogatory', 'offensive', 'pejorative', 'slur', 'ethnic', 'taboo'])
const NEIGHBOURS = [
  ['meaning', 'Meaning', 'closest in the meaning space (definitions + usage)'],
  ['sound', 'Sound', 'phonetic distance'],
  ['rhymes', 'Rhymes', 'same sound from the stressed vowel'],
  ['form', 'Spelling', 'shared letter sequences'],
  ['anagrams', 'Anagrams', 'same letters'],
  ['within', 'Contains', 'longer words built on it']
]

let root
let pop
let token = 0
let expanded = false
const relatedCache = new Map()

export function mountDetail (el) {
  root = el
  pop = h('div', { popover: '', class: 'pop', id: 'pop-member' })
  document.body.append(pop)
  root.addEventListener('click', onClick)
  root.addEventListener('dblclick', onDblClick)
  store.subscribe((s, ch) => {
    if (ch.has('w')) { expanded = false; render() } else if (['len', 'syl', 'zipf', 'pos', 'inc', 'exc', 'pre', 'mid', 'suf', 'dq', 'hide', 'need', 'shape', 'shapeNot', 'saved'].some(k => ch.has(k))) renderNeighbours()
  })
  lists.subscribe(() => { if (store.get().w) { renderActions(); renderNotes(); markSaved() } })
  render()
}

// A single click here navigates the whole panel to the clicked word, which would otherwise pull the rug out
// from under a real double-click: the second click's hit-test would land on whatever the (now different) panel
// put at that same spot. So the navigate is held for one double-click interval per word, and a second click on
// that same word cancels it and toggles save instead — reliable regardless of how the panel re-renders.
const DBLCLICK_MS = 280
const pendingNav = new Map()

function onClick (e) {
  const a = e.target.closest('[data-w]')
  if (!a) return
  e.preventDefault()
  if (e.detail > 1) return // part of a double-click; onDblClick handles it
  const w = a.dataset.w
  clearTimeout(pendingNav.get(w))
  pendingNav.set(w, setTimeout(() => { pendingNav.delete(w); selectWord(w, e) }, DBLCLICK_MS))
}

function onDblClick (e) {
  const a = e.target.closest('[data-w]')
  if (!a) return
  e.preventDefault()
  const w = a.dataset.w
  clearTimeout(pendingNav.get(w))
  pendingNav.delete(w)
  toggleSave(w)
}

function currentId () {
  const w = store.get().w
  return w ? idOf(w) : -1
}

function render () {
  const my = ++token
  const w = store.get().w
  const app = document.getElementById('app')
  app.classList.toggle('has-detail', !!w)
  if (!w) { fill(root); return }
  const id = idOf(w)
  if (id < 0) {
    // coined words (blends, your own inventions) still get the tools that don't need a dictionary entry
    fill(root, h('div', { class: 'd' },
      top(-1),
      h('h1', { class: 'd-word' }, w),
      h('div', { class: 'd-pron' }, 'Coined — not in the word list'),
      h('div', { class: 'd-actions', id: 'd-actions' }),
      h('div', { class: 'receipt' }, h('div', { class: 'ln' }, h('span', null, 'Letters'), h('span', { class: 'leader' }), h('span', null, String(w.length)))),
      h('section', { class: 'd-sec', id: 'd-notes', hidden: true }),
      specimen(w),
      outlinks(w)))
    renderActions()
    renderNotes()
    return
  }
  const fl = lex.flags[id]
  fill(root, h('div', { class: 'd' },
    top(id),
    h('h1', { class: 'd-word', lang: 'en' }, w),
    h('div', { class: 'd-pron', id: 'd-pron' }, fl & F.pron ? ' ' : null),
    h('div', { class: 'd-actions', id: 'd-actions' }),
    receipt(id, null),
    h('section', { class: 'd-sec', id: 'd-defs' }, h('h3', null, 'Definitions'), h('p', { class: 'd-loading' }, 'Loading')),
    h('section', { class: 'd-sec', id: 'd-rel', hidden: true }),
    h('section', { class: 'd-sec', id: 'd-nb' }),
    h('section', { class: 'd-sec', id: 'd-notes', hidden: true }),
    specimen(w),
    outlinks(w)
  ))
  root.scrollTop = 0
  renderActions()
  renderNotes()
  renderNeighbours()
  entry(w).then(e => { if (my === token) fillEntry(id, w, e) })
}

function top (id) {
  return h('div', { class: 'd-top' },
    h('div', { class: 'd-nav' },
      h('button', { class: 'btn ghost', title: 'Back ([)', 'aria-label': 'Back', onclick: () => history.back() }, '←'),
      h('button', { class: 'btn ghost', title: 'Forward (])', 'aria-label': 'Forward', onclick: () => history.forward() }, '→')),
    id >= 0 ? h('span', { class: 'label num' }, `No. ${fmt.format(id + 1)} / ${fmt.format(lex.N)}`) : h('span'),
    h('button', { class: 'btn ghost', title: 'Close (Esc)', onclick: () => store.set({ w: '' }, { push: true }) }, 'Close'))
}

function renderActions () {
  const el = root.querySelector('#d-actions')
  const w = store.get().w
  if (!el || !w) return
  const saved = lists.has(w)
  const others = lists.listsWith(w).filter(l => l.id !== lists.active().id).length
  const membersBtn = h('button', { class: 'btn', title: 'Choose lists', 'aria-haspopup': 'dialog' }, others ? `Lists · ${others + (saved ? 1 : 0)}` : 'Lists')
  membersBtn.addEventListener('click', () => openPopover(pop, membersBtn, p => renderMembership(p, w)))
  fill(el,
    h('button', { class: 'btn' + (saved ? ' saved' : ''), title: `Save to ${lists.active().name} (S)`, onclick: () => toggleSave(w) }, saved ? 'Saved' : 'Save'),
    membersBtn,
    idOf(w) >= 0 ? h('button', { class: 'btn', title: 'Add to cloud seeds (+)', onclick: () => addSeed(w, 1) }, '+ Seed') : null,
    idOf(w) >= 0 ? h('button', { class: 'btn', title: 'Start a cloud from this word (C)', onclick: () => openCloud(w) }, 'Cloud') : null,
    h('button', { class: 'btn ghost', title: 'Copy word', onclick: () => copy(w, `Copied “${w}”`) }, 'Copy')
  )
}

const STRESS = { 1: '●', 2: '◐', 0: '○' }

function receipt (id, e) {
  const w = lex.words[id]
  const fl = lex.flags[id]
  const z = lex.zipf[id]
  const vowels = (w.match(/[aeiou]/g) || []).length
  const ln = (k, v) => h('div', { class: 'ln' }, h('span', null, k), h('span', { class: 'leader' }), h('span', null, v))
  const types = posList(lex.pos[id]).map(p => POS_LONG[p]).join(', ')
  const status = []
  if (fl & F.infl) status.push('Inflected form')
  if (fl & F.proper) status.push('Name / place')
  if (fl & F.abbr) status.push('Abbreviation')
  if (fl & F.taxon) status.push('Latin taxon')
  if (fl & F.archaic) status.push('Archaic')
  if (fl & F.sensitive) status.push('Offensive sense')
  return h('div', { class: 'receipt', id: 'd-receipt' },
    ln('Letters', `${w.length}  (${vowels}v ${w.length - vowels}c)`),
    ln('Syllables', String(lex.syl[id]) + (fl & F.pron ? '' : ' ≈')),
    h('div', { class: 'ln', id: 'd-stress', hidden: true }),
    types ? ln('Type', types) : null,
    ln('Frequency', z ? `${band(z)} · ${(z / 10).toFixed(1)}` : 'Unattested'),
    status.length ? ln('Note', status.join(' · ')) : null
  )
}

function fillEntry (id, w, e) {
  // pronunciation + stress
  const pron = root.querySelector('#d-pron')
  if (e?.p) fill(pron, `/${e.p}/`)
  else pron.remove()
  const st = root.querySelector('#d-stress')
  if (e?.st && st) {
    st.hidden = false
    fill(st, h('span', null, 'Stress'), h('span', { class: 'leader' }), h('span', { style: { letterSpacing: '.2em' } }, [...e.st].map(v => STRESS[v] || '○').join('')))
  }

  // definitions
  const defs = root.querySelector('#d-defs')
  const sec = []
  const senses = [...(e?.s || []).map(s => ({ p: s[0], g: s[1], ex: s[2], src: 'wn' })), ...(e?.x || []).map(s => ({ p: s[0], g: s[1], tags: s[3], src: 'wk' }))]
  const srcs = [e?.s?.length && 'WordNet', e?.x?.length && 'Wiktionary'].filter(Boolean).join(' · ')
  sec.push(h('h3', null, 'Definitions', srcs ? h('span', { class: 'aside' }, srcs) : null))
  if (e?.b) sec.push(h('p', { style: { marginBottom: '12px' } }, h('span', { class: 'muted' }, 'Form of '), link(e.b)))
  if (e?.v) sec.push(h('p', { style: { marginBottom: '12px' } }, h('span', { class: 'muted' }, 'Also spelled '), link(e.v)))
  if (senses.length) {
    const shown = expanded ? senses : senses.slice(0, SHOW_SENSES)
    sec.push(h('ol', { class: 'senses' }, shown.map(s => h('li', { class: 'sense' },
      h('span', { class: 'p' }, POS_SHORT[s.p] || (s.p === 'name' ? 'name' : s.p || '')),
      h('span', null,
        s.tags ? h('span', { class: 'tags' }, s.tags.split(' ').map(t => h('span', { class: 'tag' + (WARN_TAGS.has(t) ? ' warn' : '') }, t.replace(/-/g, ' ')))) : null,
        s.g,
        s.ex ? h('span', { class: 'ex' }, s.ex) : null)))))
    if (senses.length > SHOW_SENSES) {
      sec.push(h('button', { class: 'more', onclick: () => { expanded = !expanded; fillEntry(id, w, e) } }, expanded ? 'Show fewer' : `Show all ${senses.length}`))
    }
  } else if (!e?.b) {
    sec.push(h('p', { class: 'muted' }, 'No definition in WordNet or Wiktionary — try the look-up links below.'))
  }
  fill(defs, ...sec)
  if (e?.b && !senses.length) {
    entry(e.b).then(be => {
      const bs = [...(be?.s || []), ...(be?.x || [])].slice(0, 3)
      if (!bs.length || store.get().w !== w) return
      defs.append(h('ol', { class: 'senses', style: { marginTop: '4px' } }, bs.map(s => h('li', { class: 'sense' }, h('span', { class: 'p' }, POS_SHORT[s[0]] || ''), h('span', { class: 'muted' }, s[1])))))
    })
  }

  // dictionary relations
  const r = e?.r
  const rel = root.querySelector('#d-rel')
  if (r) {
    const rows = [['syn', 'Synonyms'], ['ant', 'Opposites'], ['broad', 'Broader'], ['narrow', 'Narrower'], ['rel', 'Related']].filter(([k]) => r[k]?.length)
    rel.hidden = false
    fill(rel, h('h3', null, 'Thesaurus'), h('dl', { class: 'rel' }, rows.map(([k, label]) => [h('dt', null, label), h('dd', { class: 'words' }, r[k].map(link))])))
  } else {
    rel.hidden = true
  }
  markSaved()
}

function link (w) {
  const a = h('a', { href: `#/?w=${encodeURIComponent(w)}`, 'data-w': w }, w)
  if (lists.saved().has(w)) a.classList.add('saved')
  return a
}

function markSaved () {
  const saved = lists.saved()
  for (const a of root.querySelectorAll('.words a[data-w]')) a.classList.toggle('saved', saved.has(a.dataset.w))
}

async function renderNeighbours () {
  const sec = root.querySelector('#d-nb')
  const id = currentId()
  if (!sec || id < 0) return
  const my = token
  const f = filterOf(store.get())
  if (f.saved !== 'any') {
    f.savedIds = [...lists.saved()].map(idOf).filter(i => i >= 0)
    f.savedKey = f.savedIds.join(',')
  }
  const key = id + JSON.stringify(f)
  fill(sec, h('h3', null, 'Neighbours', h('span', { class: 'aside' }, 'filters apply')), h('p', { class: 'd-loading' }, 'Computing'))
  let res = relatedCache.get(key)
  if (!res) {
    res = await latest('related', 'related', { id, filter: f })
    if (res === STALE || my !== token) return
    relatedCache.set(key, res)
    if (relatedCache.size > 60) relatedCache.delete(relatedCache.keys().next().value)
  }
  const rows = NEIGHBOURS.filter(([k]) => res[k]?.length)
  fill(sec,
    h('h3', null, 'Neighbours', h('span', { class: 'aside' }, 'Shift-click adds a seed')),
    rows.length
      ? h('dl', { class: 'rel' }, rows.map(([k, label, hint]) => [h('dt', { title: hint }, label), h('dd', { class: 'words' }, res[k].slice(0, k === 'meaning' ? 36 : 24).map(i => link(lex.words[i])))]))
      : h('p', { class: 'muted' }, 'Nothing nearby with the current filters.')
  )
}

function renderNotes () {
  const sec = root.querySelector('#d-notes')
  const w = store.get().w
  if (!sec || !w) return
  const holding = lists.listsWith(w)
  if (!holding.length) { sec.hidden = true; return }
  if (sec.contains(document.activeElement)) return
  sec.hidden = false
  fill(sec, h('h3', null, 'Notes'), ...holding.map(l => {
    const it = l.items.find(x => x.w === w)
    const ta = h('textarea', { class: 'field d-note', rows: 2, placeholder: `Why “${w}”? (${l.name})`, 'aria-label': `Note in ${l.name}` }, it?.note || '')
    let t = 0
    ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => lists.update(w, { note: ta.value }, l.id), 300) })
    return holding.length > 1 ? h('label', { class: 'fine', style: { display: 'block', marginTop: '8px' } }, l.name, ta) : ta
  }))
}

function specimen (w) {
  const t = w.charAt(0).toUpperCase() + w.slice(1)
  return h('section', { class: 'd-sec' },
    h('h3', null, 'Specimen'),
    h('div', { class: 'specimen', 'aria-hidden': 'true' },
      h('div', null, h('span', { class: 's1' }, t)),
      h('div', null, h('span', { class: 's2' }, t)),
      h('div', null, h('span', { class: 's3' }, w)),
      h('div', null, h('span', { class: 's4' }, w)))
  )
}

function outlinks (w) {
  const q = encodeURIComponent(w)
  const links = [
    ['Etymology', `https://www.etymonline.com/word/${q}`],
    ['Wiktionary', `https://en.wiktionary.org/wiki/${q}`],
    ['Merriam-Webster', `https://www.merriam-webster.com/dictionary/${q}`],
    ['Domains', `https://instantdomainsearch.com/?q=${q}`],
    ['Web', `https://www.google.com/search?q=%22${q}%22`]
  ]
  return h('section', { class: 'd-sec' },
    h('h3', null, 'Look up'),
    h('div', { class: 'outlinks' }, links.map(([l, href]) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, l + ' ↗'))))
}

