// Wordable engine — runs off the main thread.
// Holds the lexicon and answers: query (filter/sort/group), related (per-word neighbours), cloud (multi-seed
// similarity with clustering and blends). Heavy assets (vectors, phonemes, definitions) load on first use.

const DATA = new URL('../data/', import.meta.url)

const F = { def: 1, vec: 2, proper: 4, abbr: 8, infl: 16, pron: 32, variant: 64, taxon: 128, archaic: 256, sensitive: 512, negated: 1024, defvec: 2048 }
const S = { double: 1, isogram: 2, palindrome: 4, pronounceable: 8, vowelStart: 16, vowelEnd: 32 }

let words, N, flags, zipf, syl, pos, lens, letterMask, shape
let revRank = null            // rank of each word when sorted by its reversed spelling
let phon = null               // { codes: string[], stress: string[], rhyme: string[] }
let vec = null                // { dim, rows: Int8Array, ids: Uint32Array, rowOf: Int32Array }
let anagramIndex = null
let glosses = null            // lower-cased definition text per word id
const shards = new Map()      // letter -> Promise<object>
let maskCache = { key: '', mask: null }

// ------------------------------------------------------------------ boot

async function init () {
  const [txt, meta] = await Promise.all([
    fetch(new URL('words.txt', DATA)).then(r => r.text()),
    fetch(new URL('meta.bin', DATA)).then(r => r.arrayBuffer())
  ])
  words = txt.split('\n')
  N = words.length
  flags = new Uint16Array(meta, 0, N)
  zipf = new Uint8Array(meta, 2 * N, N)
  syl = new Uint8Array(meta, 3 * N, N)
  pos = new Uint8Array(meta, 4 * N, N)
  lens = new Uint8Array(N)
  letterMask = new Uint32Array(N)
  shape = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    const w = words[i]
    lens[i] = w.length
    let m = 0
    let s = 0
    let prev = -1
    let dbl = false
    let iso = true
    for (let k = 0; k < w.length; k++) {
      const c = w.charCodeAt(k) - 97
      const bit = 1 << c
      if (m & bit) iso = false
      m |= bit
      if (c === prev) dbl = true
      prev = c
    }
    letterMask[i] = m
    if (dbl) s |= S.double
    if (iso) s |= S.isogram
    if (w.length > 2 && isPalindrome(w)) s |= S.palindrome
    if (pronounceable(w)) s |= S.pronounceable
    if (VOWEL.has(w[0])) s |= S.vowelStart
    if (VOWEL.has(w[w.length - 1]) || w.endsWith('y')) s |= S.vowelEnd
    shape[i] = s
  }
  return { count: N }
}

const VOWEL = new Set(['a', 'e', 'i', 'o', 'u'])
const ONSET3 = new Set(['str', 'spr', 'scr', 'spl', 'squ', 'thr', 'chr', 'shr', 'sch', 'phr'])

function isPalindrome (w) {
  for (let a = 0, b = w.length - 1; a < b; a++, b--) if (w[a] !== w[b]) return false
  return true
}

function isVowelAt (w, k) {
  const ch = w[k]
  if (VOWEL.has(ch)) return true
  return ch === 'y' && k > 0 && !VOWEL.has(w[k - 1])
}

// Rough "can you say it" test: sane consonant clusters, no letter tripled, at least one vowel.
function pronounceable (w) {
  let run = 0
  let vrun = 0
  let hasV = false
  for (let k = 0; k < w.length; k++) {
    if (k >= 2 && w[k] === w[k - 1] && w[k] === w[k - 2]) return false
    if (isVowelAt(w, k)) {
      if (run > 0 && !clusterOk(w, k - run, run, false)) return false
      run = 0
      vrun++
      hasV = true
      if (vrun > 3) return false
    } else {
      run++
      vrun = 0
    }
  }
  if (!hasV) return false
  return run === 0 || clusterOk(w, w.length - run, run, true)
}

function clusterOk (w, start, n, atEnd) {
  if (start === 0) return n <= 2 || (n === 3 && ONSET3.has(w.slice(0, 3)))
  if (atEnd) return n <= 3
  return n <= 3
}

// ------------------------------------------------------------------ filtering

function compileQuery (q, qm) {
  q = (q || '').trim().toLowerCase()
  if (!q) return null
  if (q.length > 2 && q.startsWith('/') && q.endsWith('/')) {
    try { const re = new RegExp(q.slice(1, -1), 'i'); return { kind: 'regex', test: w => re.test(w) } } catch { return { kind: 'bad' } }
  }
  if (qm === 'defs') {
    const toks = q.split(/[^a-z]+/).filter(t => t.length > 1)
    if (!toks.length) return null
    return { kind: 'defs', toks, res: toks.map(t => new RegExp('\\b' + t)) }
  }
  if (/[*?]/.test(q)) {
    const body = q.replace(/[^a-z*?]/g, '').replace(/\*+/g, '*').split('').map(c => c === '*' ? '.*' : c === '?' ? '.' : c).join('')
    const re = new RegExp('^' + body + '$')
    return { kind: 'pattern', test: w => re.test(w) }
  }
  const s = q.replace(/[^a-z]/g, '')
  if (!s) return null
  if (qm === 'contains') return { kind: 'contains', s, test: w => w.includes(s) }
  if (qm === 'ends') return { kind: 'ends', s, test: w => w.endsWith(s) }
  return { kind: 'starts', s }
}

function lowerBound (s) {
  let lo = 0
  let hi = N
  while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid] < s) lo = mid + 1; else hi = mid }
  return lo
}

function lettersToMask (s) {
  let m = 0
  for (const ch of (s || '').toLowerCase()) { const c = ch.charCodeAt(0) - 97; if (c >= 0 && c < 26) m |= 1 << c }
  return m
}

// Everything except the text query: used by explore, and on its own by related/cloud.
function baseMask (f) {
  const key = JSON.stringify([f.len, f.syl, f.zipf, f.pos, f.inc, f.exc, f.hide, f.need, f.shape, f.shapeNot, f.saved, f.savedKey])
  if (maskCache.key === key) return maskCache.mask
  const mask = new Uint8Array(N)
  const [l0, l1] = f.len || [1, 99]
  const [s0, s1] = f.syl || [1, 99]
  const [z0, z1] = f.zipf || [0, 80]
  const posM = f.pos | 0
  const inc = lettersToMask(f.inc)
  const exc = lettersToMask(f.exc)
  const hide = f.hide | 0
  const need = f.need | 0
  const shp = f.shape | 0
  const shpNot = f.shapeNot | 0
  let saved = null
  if (f.saved === 'only' || f.saved === 'hide') {
    saved = new Uint8Array(N)
    for (const i of f.savedIds || []) saved[i] = 1
  }
  for (let i = 0; i < N; i++) {
    const L = lens[i]
    if (L < l0 || L > l1) continue
    const y = syl[i]
    if (y < s0 || y > s1) continue
    const z = zipf[i]
    if (z < z0 || z > z1) continue
    if (posM && !(pos[i] & posM)) continue
    const fl = flags[i]
    if (fl & hide) continue
    if ((fl & need) !== need) continue
    const lm = letterMask[i]
    if ((lm & inc) !== inc || (lm & exc)) continue
    const sh = shape[i]
    if ((sh & shp) !== shp || (sh & shpNot)) continue
    if (saved && (f.saved === 'only') !== (saved[i] === 1)) continue
    mask[i] = 1
  }
  maskCache = { key, mask }
  return mask
}

async function query (f) {
  const t0 = performance.now()
  const mask = baseMask(f)
  const cq = compileQuery(f.q, f.qm)
  let out = new Uint32Array(N)
  let n = 0
  let relevance = null
  if (cq && cq.kind === 'bad') {
    return { ids: new Uint32Array(0), groups: [], took: 0, error: 'Invalid regular expression' }
  } else if (cq && cq.kind === 'starts') {
    const lo = lowerBound(cq.s)
    for (let i = lo; i < N && words[i].startsWith(cq.s); i++) if (mask[i]) out[n++] = i
  } else if (cq && cq.kind === 'defs') {
    await loadGlosses()
    relevance = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue
      const g = glosses[i]
      if (!g) continue
      let ok = true
      for (const re of cq.res) if (!re.test(g)) { ok = false; break }
      if (!ok) continue
      out[n++] = i
      relevance[i] = defRelevance(g, cq, zipf[i])
    }
  } else if (cq) {
    for (let i = 0; i < N; i++) if (mask[i] && cq.test(words[i])) out[n++] = i
  } else {
    for (let i = 0; i < N; i++) if (mask[i]) out[n++] = i
  }
  out = out.slice(0, n)

  let sort = f.sort || 'az'
  if (sort === 'best' && !relevance) {
    relevance = new Float32Array(N)
    const s = cq?.s || ''
    for (const i of out) relevance[i] = (words[i] === s ? 1000 : 0) + zipf[i] * 3 - lens[i]
  }
  out = sortIds(out, sort, f.seed | 0, relevance)
  const groups = f.group && f.group !== 'none' ? groupIds(out, f.group) : null
  if (groups) out = groups.ids
  return { ids: out, groups: groups ? groups.list : [], took: performance.now() - t0 }
}

// Rank a definition hit: the sense that covers the most query words, early senses first, and short focused
// glosses over long ones where the words are incidental; a little frequency to break ties.
function defRelevance (g, cq, z) {
  const senses = g.split(' | ')
  let best = 0
  for (let k = 0; k < senses.length; k++) {
    const sense = senses[k]
    let hit = 0
    let chars = 0
    for (let t = 0; t < cq.res.length; t++) if (cq.res[t].test(sense)) { hit++; chars += cq.toks[t].length }
    if (!hit) continue
    const sc = hit * 10 - k * 1.5 + 12 * chars / Math.max(12, sense.length)
    if (sc > best) best = sc
  }
  return best + z / 20
}

function sortIds (ids, sort, seed, relevance) {
  const n = ids.length
  if (sort === 'az' || n < 2) return ids
  if (sort === 'za') return ids.reverse()
  if (sort === 'random') {
    const rnd = mulberry32(seed || 1)
    for (let k = n - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); const t = ids[k]; ids[k] = ids[j]; ids[j] = t }
    return ids
  }
  if (sort === 'ending' && !revRank) buildRevRank()
  const key = new Float64Array(n)
  const SH = 1 << 20 // > N: primary key in the high part, id (alphabetical tiebreak) in the low part
  for (let k = 0; k < n; k++) {
    const i = ids[k]
    let p
    switch (sort) {
      case 'common': p = 80 - zipf[i]; break
      case 'rare': p = zipf[i]; break
      case 'short': p = lens[i]; break
      case 'long': p = 99 - lens[i]; break
      case 'syl': p = syl[i] * 100 + lens[i]; break
      case 'ending': p = revRank[i]; break
      case 'best': p = 1e6 - relevance[i] * 10; break
      default: p = 0
    }
    key[k] = p * SH + i
  }
  key.sort()
  for (let k = 0; k < n; k++) ids[k] = key[k] % SH
  return ids
}

function buildRevRank () {
  const order = Array.from({ length: N }, (_, i) => i)
  const rev = words.map(w => w.split('').reverse().join(''))
  order.sort((a, b) => (rev[a] < rev[b] ? -1 : rev[a] > rev[b] ? 1 : 0))
  revRank = new Uint32Array(N)
  order.forEach((id, r) => { revRank[id] = r })
}

const BANDS = [[50, 'Very common'], [40, 'Common'], [30, 'Familiar'], [20, 'Uncommon'], [1, 'Rare'], [0, 'Unattested']]
const POS_GROUPS = [[1, 'Nouns'], [2, 'Verbs'], [4, 'Adjectives'], [8, 'Adverbs']]

function groupKey (i, g) {
  switch (g) {
    case 'letter': return words[i].charCodeAt(0) - 97
    case 'length': return lens[i]
    case 'syl': return syl[i]
    case 'freq': { const z = zipf[i]; return BANDS.findIndex(b => z >= b[0]) }
    case 'pos': { const p = pos[i]; const k = POS_GROUPS.findIndex(b => p & b[0]); return k < 0 ? 4 : k }
  }
  return 0
}

function groupLabel (k, g) {
  switch (g) {
    case 'letter': return String.fromCharCode(97 + k).toUpperCase()
    case 'length': return `${k} letter${k === 1 ? '' : 's'}`
    case 'syl': return `${k} syllable${k === 1 ? '' : 's'}`
    case 'freq': return BANDS[k][1]
    case 'pos': return k < 4 ? POS_GROUPS[k][1] : 'Other'
  }
  return ''
}

// Stable bucket partition: keeps the chosen sort inside each group.
function groupIds (ids, g) {
  const counts = new Map()
  const keys = new Int32Array(ids.length)
  for (let k = 0; k < ids.length; k++) { const key = groupKey(ids[k], g); keys[k] = key; counts.set(key, (counts.get(key) || 0) + 1) }
  const order = [...counts.keys()].sort((a, b) => a - b)
  const start = new Map()
  let acc = 0
  const list = order.map(key => { start.set(key, acc); const c = counts.get(key); const item = { key, label: groupLabel(key, g), start: acc, count: c }; acc += c; return item })
  const out = new Uint32Array(ids.length)
  for (let k = 0; k < ids.length; k++) { const key = keys[k]; const p = start.get(key); out[p] = ids[k]; start.set(key, p + 1) }
  return { ids: out, list }
}

function mulberry32 (a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// ------------------------------------------------------------------ lazy assets

function shard (letter) {
  if (!shards.has(letter)) {
    shards.set(letter, fetch(new URL(`defs/${letter}.json`, DATA)).then(r => (r.ok ? r.json() : {})).catch(() => ({})))
  }
  return shards.get(letter)
}

async function entry (w) { return (await shard(w[0]))[w] || null }

async function loadGlosses () {
  if (glosses) return
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('')
  let done = 0
  const g = new Array(N)
  await Promise.all(letters.map(async L => {
    const d = await shard(L)
    for (const w in d) {
      const e = d[w]
      const parts = []
      for (const s of e.s || []) parts.push(s[1])
      for (const s of e.x || []) parts.push(s[1])
      if (parts.length) {
        const i = idOf(w)
        if (i >= 0) g[i] = parts.join(' | ').toLowerCase()
      }
    }
    postMessage({ type: 'progress', what: 'definitions', done: ++done, total: letters.length })
  }))
  glosses = g
}

function idOf (w) {
  const i = lowerBound(w)
  return i < N && words[i] === w ? i : -1
}

let phonPromise = null
function loadPhon () {
  if (!phonPromise) {
    phonPromise = fetch(new URL('phon.txt', DATA)).then(r => r.text()).then(txt => {
      const lines = txt.split('\n')
      const codes = new Array(N)
      const rhyme = new Array(N)
      for (let i = 0; i < N; i++) {
        const line = lines[i]
        if (!line) continue
        const [c, st] = line.split('\t')
        codes[i] = c
        rhyme[i] = rhymeKey(c, st)
      }
      phon = { codes, rhyme }
      return phon
    })
  }
  return phonPromise
}

// From the last primary-stressed vowel to the end ("light" -> AY T).
function rhymeKey (codes, stress) {
  let vIdx = -1
  let target = stress.lastIndexOf('1')
  if (target < 0) target = stress.length - 1
  let seen = -1
  for (let k = 0; k < codes.length; k++) {
    if (isVowelCode(codes.charCodeAt(k))) { seen++; if (seen === target) { vIdx = k; break } }
  }
  return vIdx < 0 ? codes : codes.slice(vIdx)
}

function isVowelCode (c) { return c >= 65 && c <= 79 } // 'A'..'O'

let vecPromise = null
function loadVectors () {
  if (!vecPromise) {
    vecPromise = Promise.all([
      fetch(new URL('manifest.json', DATA)).then(r => r.json()),
      fetch(new URL('vectors.bin', DATA)).then(r => r.arrayBuffer()),
      fetch(new URL('vector_ids.bin', DATA)).then(r => r.arrayBuffer())
    ]).then(([man, rows, ids]) => {
      const dim = man.vectors.dim
      const idArr = new Uint32Array(ids)
      const rowOf = new Int32Array(N).fill(-1)
      for (let r = 0; r < idArr.length; r++) rowOf[idArr[r]] = r
      vec = { dim, rows: new Int8Array(rows), ids: idArr, rowOf }
      return vec
    })
  }
  return vecPromise
}

// ------------------------------------------------------------------ similarity: meaning

function unitQuery (seeds) {
  const { dim, rows, rowOf } = vec
  const q = new Float32Array(dim)
  let used = 0
  for (const s of seeds) {
    const r = rowOf[s.id]
    if (r < 0) continue
    const off = r * dim
    for (let d = 0; d < dim; d++) q[d] += rows[off + d]
    used++
  }
  if (!used) return null
  let norm = 0
  for (let d = 0; d < dim; d++) norm += q[d] * q[d]
  norm = Math.sqrt(norm) || 1
  for (let d = 0; d < dim; d++) q[d] /= norm * 127
  return q
}

// Cosine to the positive seeds' centroid, minus a penalty for resembling any negative seed.
// Pushing away by penalty (rather than subtracting vectors) keeps the field on-topic: "swift − car" stays about
// speed and birds instead of drifting to whatever lies opposite a car.
// `defDiscount` tempers words whose vector comes only from their definition (they sit near concept centroids).
function meaningScores (seeds, mask, defDiscount = 0.9) {
  const out = new Float32Array(N).fill(-2)
  const q = unitQuery(seeds.filter(s => s.sign > 0))
  if (!q) return null
  const negs = seeds.filter(s => s.sign < 0).map(s => unitQuery([s])).filter(Boolean)
  const { dim, rows, ids } = vec
  const M = ids.length
  for (let r = 0; r < M; r++) {
    const i = ids[r]
    if (!mask[i]) continue
    const off = r * dim
    let s = 0
    for (let d = 0; d < dim; d++) s += q[d] * rows[off + d]
    for (const n of negs) {
      let c = 0
      for (let d = 0; d < dim; d++) c += n[d] * rows[off + d]
      if (c > 0.15) s -= 0.9 * (c - 0.15)
    }
    const fl = flags[i]
    if (fl & F.negated) s *= 0.72
    if (fl & F.defvec) s *= defDiscount
    out[i] = s
  }
  return out
}

// ------------------------------------------------------------------ similarity: sound

const SUB = (() => {
  const t = new Float32Array(128 * 128).fill(1)
  // consonant codes: a=B b=CH c=D d=DH e=F f=G g=HH h=JH i=K j=L k=M l=N m=NG n=P o=R p=S q=SH r=T s=TH t=V u=W v=Y w=Z x=ZH
  // near pairs: B/P D/T G/K F/V S/Z SH/ZH CH/JH TH/DH M/N N/NG L/R W/Y T/TH D/DH S/SH
  const near = [['a', 'n'], ['c', 'r'], ['f', 'i'], ['e', 't'], ['p', 'w'], ['q', 'x'], ['b', 'h'], ['s', 'd'], ['k', 'l'], ['l', 'm'], ['j', 'o'], ['u', 'v'], ['r', 's'], ['c', 'd'], ['p', 'q']]
  for (let a = 65; a <= 79; a++) for (let b = 65; b <= 79; b++) t[a * 128 + b] = 0.55 // vowel for vowel
  for (const [x, y] of near) { const a = x.charCodeAt(0); const b = y.charCodeAt(0); t[a * 128 + b] = t[b * 128 + a] = 0.4 }
  for (let a = 0; a < 128; a++) t[a * 128 + a] = 0
  return t
})()

const lev = new Float32Array(64)
const lev2 = new Float32Array(64)

function weightedLev (a, b, sub) {
  const la = a.length
  const lb = b.length
  if (la > 60 || lb > 60) return Math.max(la, lb)
  let prev = lev
  let cur = lev2
  for (let j = 0; j <= lb; j++) prev[j] = j
  for (let i = 1; i <= la; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= lb; j++) {
      const cost = sub ? sub[ca * 128 + b.charCodeAt(j - 1)] : (ca === b.charCodeAt(j - 1) ? 0 : 1)
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      cur[j] = v
    }
    const t = prev; prev = cur; cur = t
  }
  return prev[lb]
}

function affix (a, b) {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length && s < b.length && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return [p, s]
}

function phoneticSim (a, b, ra, rb) {
  const L = Math.max(a.length, b.length)
  if (Math.abs(a.length - b.length) > Math.max(3, L * 0.6)) return 0
  let s = 1 - weightedLev(a, b, SUB) / L
  const [p, x] = affix(a, b)
  if (ra && ra === rb) s += 0.35
  else s += 0.12 * Math.min(x, 3) / 3
  if (p) s += 0.08 * Math.min(p, 2) / 2
  return s / 1.43
}

// crude spelling-to-sound normalisation for words without a pronunciation
function soundSpell (w) {
  return w.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'kw').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/x/g, 'ks').replace(/gh(?![aeiou])/g, '').replace(/y/g, 'i').replace(/(.)\1+/g, '$1').replace(/([^aeiou])e$/, '$1')
}

function soundScores (seeds, mask) {
  const out = new Float32Array(N).fill(-2)
  const pos = seeds.filter(s => s.sign > 0)
  const neg = seeds.filter(s => s.sign < 0)
  if (!pos.length) return null
  const prep = s => ({ code: phon.codes[s.id], rhyme: phon.rhyme[s.id], spell: soundSpell(words[s.id]) })
  const P = pos.map(prep)
  const Q = neg.map(prep)
  const sim = (s, i) => {
    const c = phon.codes[i]
    if (s.code && c) return phoneticSim(s.code, c, s.rhyme, phon.rhyme[i])
    const b = soundSpell(words[i])
    const L = Math.max(s.spell.length, b.length)
    if (Math.abs(s.spell.length - b.length) > Math.max(3, L * 0.6)) return 0
    const [, x] = affix(s.spell, b)
    return 0.9 * (1 - weightedLev(s.spell, b, null) / L + 0.15 * Math.min(x, 3) / 3) / 1.15
  }
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue
    // pronunciation-less words only compete when some seed also lacks one (keeps the list phonetic)
    if (!phon.codes[i] && P.every(s => s.code)) continue
    let s = 0
    for (const p of P) s += sim(p, i)
    s /= P.length
    for (const q of Q) s -= 0.5 * sim(q, i)
    out[i] = s
  }
  return out
}

// ------------------------------------------------------------------ similarity: form (spelling)

function trigrams (w, set) {
  const pad = '{' + w + '{' // '{' is char 123 -> code 26
  let n = 0
  for (let k = 0; k + 2 < pad.length; k++) {
    const c = ((pad.charCodeAt(k) - 97) * 27 + (pad.charCodeAt(k + 1) - 97)) * 27 + (pad.charCodeAt(k + 2) - 97)
    if (set) set[c] = 1
    n++
  }
  return n
}

function formScores (seeds, mask) {
  const out = new Float32Array(N).fill(-2)
  const pos = seeds.filter(s => s.sign > 0)
  if (!pos.length) return null
  const neg = seeds.filter(s => s.sign < 0)
  const P = pos.map(s => { const set = new Uint8Array(27 * 27 * 27); const n = trigrams(words[s.id], set); return { w: words[s.id], set, n } })
  const Q = neg.map(s => { const set = new Uint8Array(27 * 27 * 27); const n = trigrams(words[s.id], set); return { w: words[s.id], set, n } })
  const sim = (p, i) => {
    const w = words[i]
    const pad = '{' + w + '{'
    let common = 0
    let n = 0
    for (let k = 0; k + 2 < pad.length; k++) {
      const c = ((pad.charCodeAt(k) - 97) * 27 + (pad.charCodeAt(k + 1) - 97)) * 27 + (pad.charCodeAt(k + 2) - 97)
      if (p.set[c]) common++
      n++
    }
    if (!common) return 0
    let s = (2 * common) / (p.n + n)
    const [a, b] = affix(p.w, w)
    if (a >= 3) s += 0.1 * Math.min(a, 6) / 6
    if (b >= 3) s += 0.1 * Math.min(b, 6) / 6
    return s
  }
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue
    let s = 0
    for (const p of P) s += sim(p, i)
    s /= P.length
    for (const q of Q) s -= 0.5 * sim(q, i)
    out[i] = s
  }
  return out
}

// ------------------------------------------------------------------ ranking helpers

function topK (scores, k, exclude) {
  // partial selection: keep a running min-heap of size k
  const heapI = new Int32Array(k)
  const heapS = new Float32Array(k)
  let size = 0
  const sift = (pos) => {
    for (;;) {
      const l = 2 * pos + 1
      const r = l + 1
      let m = pos
      if (l < size && heapS[l] < heapS[m]) m = l
      if (r < size && heapS[r] < heapS[m]) m = r
      if (m === pos) return
      const ti = heapI[pos]; heapI[pos] = heapI[m]; heapI[m] = ti
      const ts = heapS[pos]; heapS[pos] = heapS[m]; heapS[m] = ts
      pos = m
    }
  }
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]
    if (s <= -1.5 || (exclude && exclude.has(i))) continue
    if (size < k) {
      let p = size++
      heapI[p] = i; heapS[p] = s
      while (p > 0) {
        const parent = (p - 1) >> 1
        if (heapS[parent] <= heapS[p]) break
        const ti = heapI[p]; heapI[p] = heapI[parent]; heapI[parent] = ti
        const ts = heapS[p]; heapS[p] = heapS[parent]; heapS[parent] = ts
        p = parent
      }
    } else if (s > heapS[0]) {
      heapI[0] = i; heapS[0] = s
      sift(0)
    }
  }
  const res = []
  for (let k2 = 0; k2 < size; k2++) res.push(heapI[k2])
  return res.sort((a, b) => scores[b] - scores[a])
}

const INFL_SUFFIX = ['s', 'es', 'ed', 'd', 'ing', 'er', 'ers', 'est', 'ly', 'ness', 'ies']

// words that are just the seed wearing an inflection ("oceans" for "ocean") add nothing to a cloud
function seedEcho (seedWords) {
  const set = new Set()
  for (const w of seedWords) {
    for (const suf of INFL_SUFFIX) { const i = idOf(w + suf); if (i >= 0) set.add(i) }
    if (w.endsWith('e')) for (const suf of ['d', 'r', 's']) { const i = idOf(w + suf); if (i >= 0) set.add(i) }
    if (w.endsWith('y')) for (const suf of ['ies', 'ied', 'ier', 'iest', 'ily']) { const i = idOf(w.slice(0, -1) + suf); if (i >= 0) set.add(i) }
    for (const suf of INFL_SUFFIX) if (w.endsWith(suf) && w.length - suf.length > 2) { const i = idOf(w.slice(0, -suf.length)); if (i >= 0) set.add(i) }
  }
  return set
}

// ------------------------------------------------------------------ cloud

async function cloud ({ seeds, modes, bias = 0, limit = 150, filter, cluster }) {
  const t0 = performance.now()
  const mask = baseMask(filter || {})
  seeds = seeds.filter(s => s.id >= 0 && s.id < N)
  if (!seeds.length) return { items: [], took: 0 }
  const active = ['meaning', 'sound', 'form'].filter(m => modes[m])
  if (!active.length) active.push('meaning')
  if (active.includes('meaning')) await loadVectors()
  if (active.includes('sound')) await loadPhon()

  const exclude = new Set(seeds.map(s => s.id))
  for (const i of seedEcho(seeds.filter(s => s.sign > 0).map(s => words[s.id]))) exclude.add(i)

  // relation boost from the dictionary: synonyms and related words of positive seeds
  const boost = new Map()
  for (const s of seeds.filter(x => x.sign > 0)) {
    const e = await entry(words[s.id])
    const r = e?.r
    if (!r) continue
    for (const w of r.syn || []) addBoost(boost, w, 0.06, 'synonym')
    for (const w of [...(r.rel || []), ...(r.broad || []), ...(r.narrow || [])]) addBoost(boost, w, 0.03, 'related')
  }

  const perMode = {}
  const missing = []
  for (const m of active) {
    const sc = m === 'meaning' ? meaningScores(seeds, mask, bias > 0 ? 0.84 : bias < 0 ? 1 : 0.9) : m === 'sound' ? soundScores(seeds, mask) : formScores(seeds, mask)
    if (sc) perMode[m] = sc
    else missing.push(m)
  }
  const modesUsed = Object.keys(perMode)
  if (!modesUsed.length) return { items: [], took: performance.now() - t0, missing }

  // candidate pool: union of each mode's top results
  const pool = new Set()
  for (const m of modesUsed) for (const i of topK(perMode[m], Math.max(limit * 6, 1500), exclude)) pool.add(i)
  const maxOf = {}
  for (const m of modesUsed) {
    let mx = 1e-6
    for (const i of pool) mx = Math.max(mx, perMode[m][i])
    maxOf[m] = mx
  }
  const b = Math.max(-1, Math.min(1, bias))
  const scored = []
  for (const i of pool) {
    let s = 0
    let best = ''
    let bestV = -1
    for (const m of modesUsed) {
      const v = Math.max(0, perMode[m][i]) / maxOf[m]
      s += v
      if (v > bestV) { bestV = v; best = m }
    }
    s /= modesUsed.length
    const bo = boost.get(words[i])
    if (bo && perMode.meaning) s += bo.v
    // lean: familiar favours attested frequency, obscure favours the unattested long tail
    const zf = Math.min(1, zipf[i] / 60)
    s += b > 0 ? 0.35 * zf : b < 0 ? 0.08 * (1 - zf) : 0.1 * zf
    if (flags[i] & F.archaic) s -= b > 0 ? 0.15 : b === 0 ? 0.05 : 0
    scored.push({ id: i, score: s, why: bo && perMode.meaning ? bo.why : best })
  }
  scored.sort((x, y) => y.score - x.score)
  const items = scored.slice(0, limit)
  const top = items[0]?.score || 1
  for (const it of items) it.score = +(it.score / top).toFixed(4)

  let clusters = null
  if (cluster && perMode.meaning) clusters = clusterItems(items)
  const blends = makeBlends(seeds.filter(s => s.sign > 0).map(s => words[s.id]))
  return { items, clusters, blends, modes: modesUsed, missing, took: performance.now() - t0 }
}

function addBoost (map, w, v, why) {
  const cur = map.get(w)
  if (!cur || cur.v < v) map.set(w, { v, why })
}

// k-means on the unit vectors of the result set, farthest-point initialisation (deterministic)
function clusterItems (items) {
  const { dim, rows, rowOf } = vec
  const pts = items.filter(it => rowOf[it.id] >= 0)
  if (pts.length < 12) return null
  const k = Math.max(3, Math.min(8, Math.round(Math.sqrt(pts.length / 5))))
  const X = pts.map(it => { const r = rowOf[it.id]; const v = new Float32Array(dim); for (let d = 0; d < dim; d++) v[d] = rows[r * dim + d] / 127; return v })
  const dot = (a, b2) => { let s = 0; for (let d = 0; d < dim; d++) s += a[d] * b2[d]; return s }
  const cents = [Float32Array.from(X[0])]
  while (cents.length < k) {
    let far = 0
    let farV = Infinity
    X.forEach((x, idx) => { const m = Math.max(...cents.map(c => dot(x, c))); if (m < farV) { farV = m; far = idx } })
    cents.push(Float32Array.from(X[far]))
  }
  let assign = new Int32Array(X.length)
  for (let it = 0; it < 15; it++) {
    const next = new Int32Array(X.length)
    X.forEach((x, idx) => { let best = 0; let bv = -Infinity; cents.forEach((c, ci) => { const v = dot(x, c); if (v > bv) { bv = v; best = ci } }); next[idx] = best })
    const changed = next.some((v, idx) => v !== assign[idx])
    assign = next
    for (let ci = 0; ci < k; ci++) {
      const c = new Float32Array(dim)
      let n = 0
      X.forEach((x, idx) => { if (assign[idx] === ci) { n++; for (let d = 0; d < dim; d++) c[d] += x[d] } })
      if (!n) continue
      let norm = 0
      for (let d = 0; d < dim; d++) norm += c[d] * c[d]
      norm = Math.sqrt(norm) || 1
      for (let d = 0; d < dim; d++) c[d] /= norm
      cents[ci] = c
    }
    if (!changed && it > 0) break
  }
  const groups = cents.map((c, ci) => {
    const members = []
    X.forEach((x, idx) => { if (assign[idx] === ci) members.push({ ...pts[idx], c: dot(x, c) }) })
    if (!members.length) return null
    const label = members.reduce((a, m) => (m.c + m.score * 0.3 > a.c + a.score * 0.3 ? m : a), members[0])
    members.sort((a, b) => b.score - a.score)
    return { label: label.id, ids: members.map(m => m.id), best: members[0].score }
  }).filter(Boolean)
  groups.sort((a, b) => b.best - a.best)
  return groups
}

// Portmanteaus from the first two positive seeds (both directions). Favour a shared seam letter/sound,
// keeping a recognisable piece of each word, and a sayable result.
function makeBlends (list) {
  if (list.length < 2) return []
  const out = new Map()
  const pairs = []
  for (let a = 0; a < Math.min(list.length, 4); a++) for (let b = 0; b < Math.min(list.length, 4); b++) if (a !== b) pairs.push([list[a], list[b]])
  for (const [A, B] of pairs) {
    for (let i = 2; i <= A.length; i++) {
      for (let j = 0; j <= B.length - 2; j++) {
        const cand = A.slice(0, i) + B.slice(j)
        if (cand.length < 4 || cand.length > 11 || cand === A || cand === B || A.startsWith(cand) || B.endsWith(cand) && j === 0) continue
        const keepA = i / A.length
        const keepB = (B.length - j) / B.length
        if (keepA < 0.3 || keepB < 0.3) continue
        let s = 0
        // overlap: the end of A's piece equals the start of B's piece ("motor"+"hotel" -> "motel")
        let ov = 0
        while (ov < 3 && i - ov - 1 >= 0 && j + ov < B.length && A[i - 1 - ov] === B[j + ov]) ov++
        if (A[i - 1] === B[j - 1] && j > 0) s += 0.5  // seam letter shared by both words
        s += ov * 0.25
        s += 0.6 * Math.min(keepA, keepB) + 0.2 * (keepA + keepB) / 2
        s -= Math.abs(cand.length - 7) * 0.05
        const piece = ov ? A.slice(0, i) + B.slice(j + ov) : cand
        if (piece.length < 4 || !pronounceable(piece) || /(.)\1\1/.test(piece)) continue
        const prev = out.get(piece)
        if (!prev || prev.s < s) out.set(piece, { w: piece, s, real: idOf(piece) >= 0 })
      }
    }
  }
  return [...out.values()].filter(x => !list.includes(x.w)).sort((a, b) => b.s - a.s).slice(0, 20).map(x => ({ w: x.w, real: x.real }))
}

// ------------------------------------------------------------------ related (detail panel)

async function related ({ id, filter }) {
  const mask = baseMask(filter || {})
  const w = words[id]
  const seeds = [{ id, sign: 1 }]
  const exclude = new Set([id, ...seedEcho([w])])
  const res = { id }
  await Promise.all([loadVectors(), loadPhon()])
  const m = meaningScores(seeds, mask)
  if (m) {
    for (let i = 0; i < N; i++) if (m[i] > -1.5) m[i] += 0.025 * zipf[i] / 70
    res.meaning = topK(m, 36, exclude)
  }
  const s = soundScores(seeds, mask)
  if (s) res.sound = topK(s, 30, exclude)
  const f = formScores(seeds, mask)
  if (f) res.form = topK(f, 30, exclude)

  const rk = phon.rhyme[id]
  if (rk) {
    const r = []
    for (let i = 0; i < N; i++) if (i !== id && mask[i] && phon.rhyme[i] === rk && !words[i].endsWith(w)) r.push(i)
    r.sort((a, b) => zipf[b] - zipf[a] || lens[a] - lens[b])
    res.rhymes = r.slice(0, 60)
  }
  if (!anagramIndex) {
    anagramIndex = new Map()
    for (let i = 0; i < N; i++) {
      const key = words[i].split('').sort().join('')
      const a = anagramIndex.get(key)
      if (a) a.push(i); else anagramIndex.set(key, [i])
    }
  }
  res.anagrams = (anagramIndex.get(w.split('').sort().join('')) || []).filter(i => i !== id && mask[i])
  if (w.length >= 3) {
    const c = []
    for (let i = 0; i < N; i++) if (i !== id && mask[i] && lens[i] > w.length && words[i].includes(w)) c.push(i)
    c.sort((a, b) => zipf[b] - zipf[a] || lens[a] - lens[b])
    res.within = c.slice(0, 48)
  }
  return res
}

// ------------------------------------------------------------------ rpc

const ready = init()

self.onmessage = async (ev) => {
  const { id, type, payload } = ev.data
  try {
    const boot = await ready
    let result
    let transfer = []
    switch (type) {
      case 'init': result = boot; break
      case 'query': result = await query(payload); transfer = [result.ids.buffer]; break
      case 'cloud': result = await cloud(payload); break
      case 'related': result = await related(payload); break
      case 'warm': {
        if (payload === 'vectors') await loadVectors()
        if (payload === 'phon') await loadPhon()
        if (payload === 'glosses') await loadGlosses()
        result = true
        break
      }
      default: throw new Error('unknown message ' + type)
    }
    postMessage({ id, ok: true, result }, transfer)
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.stack || err) })
  }
}
