// Popover content for choosing the active list, and for a word's membership across lists.

import { lists } from '../lists.js'
import { h, fill } from './dom.js'

export function renderActivePicker (pop) {
  const active = lists.active()
  const draw = () => {
    fill(pop,
      h('h3', null, 'Save words to'),
      lists.all().map(l => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'active-list', checked: l.id === active.id, onchange: () => { lists.setActive(l.id); pop.hidePopover() } }),
        l.name, h('span', { class: 'muted' }, String(l.items.length)))),
      h('hr', { class: 'rule' }),
      newListForm(name => { lists.create(name); pop.hidePopover() })
    )
  }
  draw()
}

export function renderMembership (pop, w) {
  const draw = () => {
    fill(pop,
      h('h3', null, `“${w}” in`),
      lists.all().map(l => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: lists.has(w, l.id), onchange: e => { if (e.target.checked) lists.add(w, l.id); else lists.removeWord(w, l.id) } }),
        l.name, h('span', { class: 'muted' }, String(l.items.length)))),
      h('hr', { class: 'rule' }),
      newListForm(name => { const l = lists.create(name); lists.add(w, l.id); draw() })
    )
  }
  draw()
}

function newListForm (onCreate) {
  const input = h('input', { class: 'field', placeholder: 'New list…', 'aria-label': 'New list name', style: { flex: '1' } })
  return h('form', { class: 'pop-row', onsubmit: e => { e.preventDefault(); if (input.value.trim()) onCreate(input.value.trim()) } },
    input, h('button', { class: 'btn', type: 'submit' }, 'Create'))
}
