// Small DOM helpers: element builder, escaping, popovers, toast, clipboard, downloads.

export function h (tag, attrs, ...kids) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue
      if (k === 'class') el.className = v
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
      else if (k === 'html') el.innerHTML = v
      else el.setAttribute(k, v === true ? '' : v)
    }
  }
  append(el, kids)
  return el
}

// replaceChildren that accepts nested arrays and skips null/false, like h()
export function fill (el, ...kids) {
  el.replaceChildren()
  append(el, kids)
  return el
}

function append (el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue
    if (Array.isArray(k)) append(el, k)
    else el.append(k instanceof Node ? k : String(k))
  }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c])

export const $ = (sel, root = document) => root.querySelector(sel)

// place a popover under (or above) its anchor, inside the viewport
export function placePopover (pop, anchor, { align = 'start' } = {}) {
  const r = anchor.getBoundingClientRect()
  const pw = pop.offsetWidth
  const ph = pop.offsetHeight
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  let left = align === 'end' ? r.right - pw : r.left
  left = Math.max(12, Math.min(left, vw - pw - 12))
  let top = r.bottom + 6
  if (top + ph > vh - 12 && r.top - ph - 6 > 12) top = r.top - ph - 6
  pop.style.left = `${left}px`
  pop.style.top = `${Math.max(12, top)}px`
}

// open a popover anchored to a button; clicking the same button again closes it
const lastClose = new WeakMap()
export function openPopover (pop, anchor, render, opts) {
  if (pop.matches(':popover-open')) {
    const same = pop._anchor === anchor
    pop.hidePopover()
    if (same) return
  } else if (pop._anchor === anchor && performance.now() - (lastClose.get(pop) || 0) < 250) {
    return // the light-dismiss that just happened was this same click
  }
  pop._anchor = anchor
  render(pop)
  pop.showPopover()
  placePopover(pop, anchor, opts)
  anchor.setAttribute('aria-expanded', 'true')
  if (!pop._wired) {
    pop._wired = true
    pop.addEventListener('toggle', (e) => {
      if (e.newState === 'closed') {
        lastClose.set(pop, performance.now())
        pop._anchor?.setAttribute('aria-expanded', 'false')
        pop._onclose?.()
      }
    })
  }
  const first = pop.querySelector('input, button, select, textarea')
  first?.focus({ preventScroll: true })
}

let toastTimer = 0
export function toast (msg, action) {
  const el = document.getElementById('pop-toast')
  fill(el, msg)
  if (action) el.append(h('button', { onclick: () => { action.run(); el.hidePopover() } }, action.label))
  if (!el.matches(':popover-open')) el.showPopover()
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.matches(':popover-open') && el.hidePopover(), action ? 5000 : 2200)
}

export async function copy (text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label) } catch { toast('Copy failed') }
}

export function download (name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = h('a', { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function isTyping (e) {
  const t = e.target
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
}

export const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
