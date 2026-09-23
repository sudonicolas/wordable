// Cross-view actions (used by views and keyboard shortcuts).

import { store } from './state.js'
import { lists } from './lists.js'
import { toast } from './ui/dom.js'

export function toggleSave (w) {
  if (!w) return
  const added = lists.toggle(w)
  const name = lists.active().name
  if (added) toast(`Saved to ${name}`)
  else toast(`Removed from ${name}`, { label: 'Undo', run: () => lists.add(w) })
}

export function addSeed (w, sign = 1) {
  if (!w) return
  const s = store.get()
  const seeds = s.seeds.filter(x => x.w !== w)
  seeds.push({ w, sign })
  store.set({ seeds }, { push: s.route !== 'cloud' })
  if (s.route !== 'cloud') toast(`${sign < 0 ? 'Pushing away from' : 'Added'} “${w}” ${sign < 0 ? 'in' : 'to'} the cloud`, { label: 'Open', run: () => store.set({ route: 'cloud' }, { push: true }) })
}

export function openCloud (w) {
  if (!w) return
  store.set({ route: 'cloud', seeds: [{ w, sign: 1 }] }, { push: true })
}

export function selectWord (w, e) {
  if (e?.shiftKey) return addSeed(w, 1)
  if (e?.altKey) return addSeed(w, -1)
  store.set({ w }, { push: true })
}
