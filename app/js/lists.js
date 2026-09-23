// Saved words, organised in lists. Persisted to localStorage and kept in sync across tabs.

const KEY = 'wordable.lists.v1'
const subs = new Set()
let db = load()
let savedCache = null

function blank () {
  const id = uid()
  return { version: 1, active: id, lists: [{ id, name: 'Shortlist', created: Date.now(), items: [] }] }
}

function load () {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const d = JSON.parse(raw)
      if (d && Array.isArray(d.lists) && d.lists.length) {
        if (!d.lists.some(l => l.id === d.active)) d.active = d.lists[0].id
        return d
      }
    }
  } catch {}
  return blank()
}

function save () {
  savedCache = null
  try { localStorage.setItem(KEY, JSON.stringify(db)) } catch (e) { console.warn('could not persist lists', e) }
  for (const fn of subs) fn()
}

function uid () { return Math.random().toString(36).slice(2, 9) }

window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  db = load()
  savedCache = null
  for (const fn of subs) fn()
})

export const lists = {
  subscribe (fn) { subs.add(fn); return () => subs.delete(fn) },
  all () { return db.lists },
  get (id) { return db.lists.find(l => l.id === id) || null },
  active () { return this.get(db.active) || db.lists[0] },
  setActive (id) { if (this.get(id)) { db.active = id; save() } },

  create (name) {
    const l = { id: uid(), name: (name || '').trim() || `List ${db.lists.length + 1}`, created: Date.now(), items: [] }
    db.lists.push(l)
    db.active = l.id
    save()
    return l
  },
  rename (id, name) { const l = this.get(id); if (l && name.trim()) { l.name = name.trim(); save() } },
  remove (id) {
    const idx = db.lists.findIndex(l => l.id === id)
    if (idx < 0) return null
    const [gone] = db.lists.splice(idx, 1)
    if (!db.lists.length) db.lists.push(blank().lists[0])
    if (db.active === id) db.active = db.lists[0].id
    save()
    return { list: gone, index: idx }
  },
  restore ({ list, index }) { db.lists.splice(index, 0, list); save() },

  has (w, id = db.active) { return !!this.get(id)?.items.some(it => it.w === w) },
  add (w, id = db.active) {
    const l = this.get(id)
    if (!l || l.items.some(it => it.w === w)) return false
    l.items.unshift({ w, note: '', stars: 0, t: Date.now() })
    save()
    return true
  },
  addMany (ws, id = db.active) {
    const l = this.get(id)
    if (!l) return 0
    const have = new Set(l.items.map(it => it.w))
    let n = 0
    for (const w of ws) if (!have.has(w)) { have.add(w); l.items.push({ w, note: '', stars: 0, t: Date.now() }); n++ }
    if (n) save()
    return n
  },
  removeWord (w, id = db.active) {
    const l = this.get(id)
    if (!l) return null
    const idx = l.items.findIndex(it => it.w === w)
    if (idx < 0) return null
    const [item] = l.items.splice(idx, 1)
    save()
    return { id, item, idx }
  },
  restoreWord ({ id, item, idx }) { const l = this.get(id); if (l) { l.items.splice(idx, 0, item); save() } },
  toggle (w, id = db.active) { return this.has(w, id) ? (this.removeWord(w, id), false) : (this.add(w, id), true) },
  update (w, patch, id = db.active) {
    const it = this.get(id)?.items.find(x => x.w === w)
    if (it) { Object.assign(it, patch); save() }
  },
  move (id, from, to) {
    const l = this.get(id)
    if (!l || from === to) return
    const [it] = l.items.splice(from, 1)
    l.items.splice(to, 0, it)
    save()
  },
  clear (id) { const l = this.get(id); if (l) { const items = l.items; l.items = []; save(); return items } return null },
  setItems (id, items) { const l = this.get(id); if (l) { l.items = items; save() } },

  // every saved word across lists
  saved () {
    if (!savedCache) {
      savedCache = new Set()
      for (const l of db.lists) for (const it of l.items) savedCache.add(it.w)
    }
    return savedCache
  },
  listsWith (w) { return db.lists.filter(l => l.items.some(it => it.w === w)) },

  exportAll () { return JSON.stringify({ app: 'wordable', exported: new Date().toISOString(), ...db }, null, 2) },
  importAll (text) {
    const d = JSON.parse(text)
    if (!d || !Array.isArray(d.lists)) throw new Error('Not a Wordable backup')
    let added = 0
    for (const l of d.lists) {
      if (!l || !Array.isArray(l.items)) continue
      const existing = db.lists.find(x => x.name === l.name)
      if (existing) {
        const have = new Set(existing.items.map(it => it.w))
        for (const it of l.items) if (it?.w && !have.has(it.w)) { existing.items.push({ note: '', stars: 0, t: Date.now(), ...it }); added++ }
      } else {
        db.lists.push({ id: uid(), name: String(l.name || 'Imported'), created: l.created || Date.now(), items: l.items.filter(it => it?.w).map(it => ({ note: '', stars: 0, t: Date.now(), ...it })) })
        added += l.items.length
      }
    }
    save()
    return added
  }
}
