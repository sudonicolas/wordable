#!/usr/bin/env python3
"""Build the browser data bundle for Wordable.

Inputs
  data/input/words_alpha.txt   370k lowercase words (the canonical vocabulary)
  data/input/words.txt         same list with original casing (proper-noun / abbreviation hints)
  data/input/uk-us-dict.txt    UK <-> US spelling pairs
  data/cache/nltk_data         WordNet 3.0 + CMU Pronouncing Dictionary (downloaded by `make data`)
  data/cache/glove-300.gz      GloVe 6B 300d (Wikipedia + Gigaword), downloaded by `make data`
  data/cache/wiktionary.db     English Wiktionary as SQLite (cstr/en-wiktionary-sqlite-full), `make data`
  wordfreq                     word frequencies (pip package)

Outputs (app/data/)
  words.txt        vocabulary, one word per line, sorted; line number == word id
  meta.bin         Uint16[N] flags, then 3 x Uint8[N]: zipf*10, syllables, part-of-speech mask
  phon.txt         one line per word: "<phoneme codes>\t<stress digits>" (empty if unknown)
  defs/<a-z>.json  per-letter shards: pronunciation, WordNet senses (s), Wiktionary senses (x),
                   relations (r), base form (b), spelling variant (v)
  vectors.bin      Int8[M x D] unit vectors (x127) - meaning space
  vector_ids.bin   Uint32[M] word id for each vector row
  manifest.json    counts, dims, encodings, build info
"""

import gzip
import json
import math
import os
import re
import sqlite3
import sys
import time
from collections import defaultdict

import numpy as np

np.seterr(all="ignore")  # numpy 2.0 + macOS Accelerate emits spurious matmul warnings; outputs are checked below

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT = os.path.join(ROOT, "data", "input")
CACHE = os.path.join(ROOT, "data", "cache")
OUT = os.path.join(ROOT, "app", "data")

os.environ.setdefault("NLTK_DATA", os.path.join(CACHE, "nltk_data"))

from nltk.corpus import cmudict  # noqa: E402
from nltk.corpus import wordnet as wn  # noqa: E402
from wordfreq import get_frequency_dict  # noqa: E402

DIM = 128              # dimensions kept after PCA
GLOVE_MAX_RANK = 120_000  # GloVe tokens beyond this rank are too noisy to trust on their own
REL_LIMIT = 36

F_DEF, F_VEC, F_PROPER, F_ABBR, F_INFL, F_PRON, F_VARIANT, F_TAXON = 1, 2, 4, 8, 16, 32, 64, 128
F_ARCHAIC, F_SENSITIVE, F_NEGATED, F_DEFVEC = 256, 512, 1024, 2048
NEG_GLOSS = re.compile(r"^(?:\(.*?\)\s*)?(?:not|without|lacking|having no|free from|devoid of|absence of|lack of|"
                       r"the opposite of|opposite of|to undo|to reverse|to remove|to deprive)\b", re.I)
NEG_SHAPE = re.compile(r"^(?:un|non|in|im|il|ir|dis|a|an|de|anti|counter|mis)\w{3,}|\w{3,}less(?:ly|ness)?$")
TAXON = re.compile(r"^(?:\w+ )?(?:genus|family|order|suborder|subfamily|superfamily|class|subclass|phylum|division|tribe) ")
TAXON_HYPER = re.compile(r"(?:^|_)(?:genus|family|order|class|phylum|division)\.n\.")
POS_BIT = {"n": 1, "v": 2, "a": 4, "s": 4, "r": 8}
POS_CHAR = {"n": "n", "v": "v", "a": "a", "s": "a", "r": "r"}

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


# ---------------------------------------------------------------- vocabulary

def read_lines(path):
    with open(path, encoding="utf-8", errors="ignore") as f:
        return [l.strip() for l in f if l.strip()]


words = sorted(set(w for w in read_lines(os.path.join(INPUT, "words_alpha.txt")) if w.isalpha() and w.isascii()))
N = len(words)
wid = {w: i for i, w in enumerate(words)}
log("vocabulary", N)

zipf = np.zeros(N, np.uint8)
syl = np.zeros(N, np.uint8)
pos = np.zeros(N, np.uint8)
flags = np.zeros(N, np.uint16)

# ---------------------------------------------------------------- casing hints

lower_seen, cap_seen, upper_seen = set(), set(), set()
for raw in read_lines(os.path.join(INPUT, "words.txt")):
    if not raw.isalpha() or not raw.isascii():
        continue
    lw = raw.lower()
    if lw not in wid:
        continue
    if raw == lw:
        lower_seen.add(lw)
    elif raw.isupper() and len(raw) > 1:
        upper_seen.add(lw)
    else:
        cap_seen.add(lw)

# ---------------------------------------------------------------- frequency

freq = get_frequency_dict("en", wordlist="best")
for w, i in wid.items():
    f = freq.get(w, 0.0)
    if f > 0:
        zipf[i] = max(1, min(80, round((math.log10(f) + 9) * 10)))
log("frequency done", int((zipf > 0).sum()), "words with frequency")

# ---------------------------------------------------------------- pronunciation

ARPA_VOWELS = ["AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"]
ARPA_CONS = ["B", "CH", "D", "DH", "F", "G", "HH", "JH", "K", "L", "M", "N", "NG", "P", "R", "S", "SH", "T",
             "TH", "V", "W", "Y", "Z", "ZH"]
# one character per phoneme: vowels upper-case, consonants lower-case
PH_CODE = {p: chr(ord("A") + i) for i, p in enumerate(ARPA_VOWELS)}
PH_CODE.update({p: chr(ord("a") + i) for i, p in enumerate(ARPA_CONS)})
IPA = {"AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ", "EH": "ɛ", "ER": "ɝ", "EY": "eɪ",
       "IH": "ɪ", "IY": "i", "OW": "oʊ", "OY": "ɔɪ", "UH": "ʊ", "UW": "u", "B": "b", "CH": "tʃ", "D": "d",
       "DH": "ð", "F": "f", "G": "ɡ", "HH": "h", "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ",
       "P": "p", "R": "r", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ", "V": "v", "W": "w", "Y": "j", "Z": "z",
       "ZH": "ʒ"}
ONSETS = {"pl", "pr", "bl", "br", "tr", "dr", "kl", "kr", "ɡl", "ɡr", "fl", "fr", "θr", "ʃr", "sl", "sm", "sn",
          "sp", "st", "sk", "sw", "tw", "dw", "kw", "spl", "spr", "str", "skr", "skw", "pj", "bj", "fj", "vj",
          "mj", "kj", "hj"}


def to_ipa(phones):
    """ARPAbet -> IPA with stress marks placed before the (maximal legal) onset."""
    segs = []  # [ipa, is_vowel, stress]
    for p in phones:
        base, st = (p[:-1], int(p[-1])) if p[-1].isdigit() else (p, -1)
        sym = IPA[base]
        if base == "AH" and st == 0:
            sym = "ə"
        if base == "ER" and st == 0:
            sym = "ɚ"
        segs.append([sym, st >= 0, st])
    out = []
    last_vowel = -1
    for i, (sym, is_v, st) in enumerate(segs):
        if is_v:
            mark = "ˈ" if st == 1 else "ˌ" if st == 2 else ""
            if mark and sum(1 for s in segs if s[1]) > 1:
                # walk back over consonants that can form an onset
                j = i
                while j - 1 > last_vowel and not segs[j - 1][1]:
                    cand = "".join(s[0] for s in segs[j - 1:i])
                    if j - 1 == i - 1 or cand in ONSETS:
                        j -= 1
                    else:
                        break
                insert_at = len(out) - (i - j)
                out.insert(insert_at, mark)
            last_vowel = i
        out.append(sym)
    return "".join(out)


def heuristic_syllables(w):
    w = w.lower()
    groups = re.findall(r"[aeiouy]+", w)
    n = len(groups)
    if w.endswith("e") and not w.endswith(("le", "ee", "ye")) and n > 1:
        n -= 1
    if re.search(r"[^aeiou]le$", w) and n == 0:
        n = 1
    n += len(re.findall(r"(?:ia|io|eo|ua|uo|ea(?=[lt]$))", w)) // 2
    return max(1, n)


cmu = cmudict.dict()
phon_lines = [""] * N
ipa = {}
for w, i in wid.items():
    prons = cmu.get(w)
    if prons:
        p = prons[0]
        vowels = [x for x in p if x[-1].isdigit()]
        syl[i] = max(1, len(vowels))
        code = "".join(PH_CODE[x.rstrip("012")] for x in p)
        stress = "".join(x[-1] for x in vowels)
        phon_lines[i] = f"{code}\t{stress}"
        ipa[w] = (to_ipa(p), stress)
        flags[i] |= F_PRON
    else:
        syl[i] = min(255, heuristic_syllables(w))
log("pronunciations", len(ipa))

# ---------------------------------------------------------------- wordnet

WN_WORD = re.compile(r"^[a-z]+$")


def lemma_word(name):
    lw = name.lower()
    return lw if WN_WORD.match(lw) and lw in wid else None


senses_of = defaultdict(list)       # word -> [synset] in sense order
lower_lemma = set()                 # words that appear as a lower-case lemma somewhere
for ss in wn.all_synsets():
    for lem in ss.lemmas():
        lw = lemma_word(lem.name())
        if lw:
            senses_of[lw].append(ss)
            if lem.name() == lw:
                lower_lemma.add(lw)

for w, sss in senses_of.items():
    order = {s: k for k, s in enumerate(wn.synsets(w))}
    uniq = list(dict.fromkeys(sss))
    uniq.sort(key=lambda s: order.get(s, 10_000))
    senses_of[w] = uniq
log("wordnet words", len(senses_of))


def names(synsets, exclude):
    out = []
    for s in synsets:
        for lem in s.lemmas():
            lw = lemma_word(lem.name())
            if lw and lw != exclude:
                out.append(lw)
    return out


def dedupe(seq, exclude=(), limit=REL_LIMIT):
    seen, out = set(exclude), []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
            if len(out) >= limit:
                break
    return out


def is_taxon(ss):
    """Latin genus / family / order names: botanical and zoological groups."""
    if ss.lexname() not in ("noun.plant", "noun.animal"):
        return False
    return bool(TAXON.match(ss.definition())) or any(TAXON_HYPER.search(h.name()) for h in ss.hypernyms())


def clean_gloss(g):
    g = re.sub(r"(?:\s*;\s*)+(?=;|$)", "", g)          # empty quote slots left by the corpus
    g = re.sub(r"\s*;?\s*-\s*[A-Z][\w.' ]+$", "", g)     # trailing "- Author" attributions
    g = re.sub(r"\s*;\s*;\s*", "; ", g)
    return g.strip(" ;")


WN_SENSITIVE = {"vulgarism.n.01", "ethnic_slur.n.01", "disparagement.n.01", "obscenity.n.02", "profanity.n.01"}

entries = {}
for w, sss in senses_of.items():
    i = wid[w]
    flags[i] |= F_DEF
    syn, ant, broad, narrow, rel = [], [], [], [], []
    senses = []
    for s in sss:
        pos[i] |= POS_BIT[s.pos()]
        ex = [e for e in s.examples() if len(e) < 140][:1]
        senses.append([POS_CHAR[s.pos()], clean_gloss(s.definition())] + ([ex[0]] if ex else []))
        syn += names([s], w)
        broad += names(s.hypernyms() + s.instance_hypernyms(), w)
        narrow += names(s.hyponyms() + s.instance_hyponyms(), w)
        rel += names(s.similar_tos() + s.also_sees() + s.attributes() + s.entailments() + s.verb_groups()
                     + s.part_meronyms() + s.member_holonyms() + s.part_holonyms() + s.substance_meronyms(), w)
        for lem in s.lemmas():
            if lem.name().lower() != w:
                continue
            ant += [lemma_word(a.name()) for a in lem.antonyms()]
            rel += [lemma_word(d.name()) for d in lem.derivationally_related_forms() + lem.pertainyms()]
    syn = dedupe(syn, (w,))
    ant = dedupe([a for a in ant if a], (w,))
    rel = dedupe([r for r in rel if r], [w] + syn + ant)
    broad = dedupe(broad, [w] + syn, 24)
    narrow = dedupe(narrow, [w] + syn, REL_LIMIT)
    if any(d.name() in WN_SENSITIVE for ss in sss for d in ss.usage_domains()):
        flags[i] |= F_SENSITIVE
    if all(is_taxon(ss) for ss in sss):
        flags[i] |= F_TAXON
    e = {"s": senses[:16]}
    r = {k: v for k, v in (("syn", syn), ("ant", ant), ("broad", broad), ("narrow", narrow), ("rel", rel)) if v}
    if r:
        e["r"] = r
    entries[w] = e

# ---------------------------------------------------------------- wiktionary
# The dump is uneven: it misses much of the core vocabulary (WordNet covers that) but has deep coverage of the
# long tail, plus usage labels and "form of" links. WordNet stays primary; Wiktionary fills in and annotates.

SHOW_TAGS = {"obsolete", "archaic", "dated", "rare", "uncommon", "slang", "informal", "colloquial", "vulgar",
             "derogatory", "offensive", "pejorative", "slur", "ethnic", "taboo", "humorous", "figuratively",
             "poetic", "literary", "formal", "euphemistic", "nonstandard", "dialectal", "regional", "historical",
             "Internet", "idiomatic", "neologism", "nonce-word", "jargon", "childish", "ironic", "sarcastic", "US",
             "UK", "British", "Australia", "Canada", "Ireland", "Scotland", "India", "New-Zealand", "South-Africa"}
OLD_TAGS = {"obsolete", "archaic", "dated"}
SENSITIVE_TAGS = {"vulgar", "derogatory", "offensive", "pejorative", "slur", "ethnic", "taboo"}
SKIP_TAGS = {"form-of", "alt-of", "misspelling", "error-misspelling", "no-gloss", "empty-gloss", "plural-of"}
WK_POS = {"noun": "n", "verb": "v", "adj": "a", "adv": "r"}

wk = sqlite3.connect(os.path.join(CACHE, "wiktionary.db"))
tag_name = dict(wk.execute("SELECT id, tag FROM tags"))
sense_tags = defaultdict(set)
for sid, tid in wk.execute("SELECT sense_id, tag_id FROM sense_tags"):
    sense_tags[sid].add(tag_name[tid])

wk_senses = defaultdict(list)     # word -> [[pos, gloss, "", tags]]
wk_form_of = {}                   # word -> base word
wk_pos_names = defaultdict(set)   # word -> wiktionary POS labels (incl. "name")
wk_old = defaultdict(lambda: [0, 0])  # word -> [old senses, all senses]
wk_sensitive = set()
rows = wk.execute("""
    SELECT e.word, e.pos, s.id, s.form_of_json, s.alt_of_json, g.gloss_text
    FROM entries e JOIN senses s ON s.entry_id = e.id JOIN glosses g ON g.sense_id = s.id
    WHERE e.lang = 'English' ORDER BY e.id, s.id, g.gloss_order""")
for word, wpos, sid, form_of, alt_of, gloss in rows:
    w = word.lower()
    if w not in wid:
        continue
    exact = word == w
    tags = sense_tags.get(sid, set())
    wk_pos_names[w].add(wpos if exact else "name")
    if form_of or alt_of or tags & SKIP_TAGS:
        ref = json.loads(form_of or alt_of or "[]")
        base = ref[0].get("word", "").lower() if ref and isinstance(ref[0], dict) else ""
        if exact and base in wid and base != w:
            wk_form_of.setdefault(w, base)
        continue
    if not exact and wk_senses[w] and wk_senses[w][0][0] != "name":
        continue  # a capitalised homograph (e.g. "Lucid") adds noise once the common word has senses
    gloss = gloss.strip()
    if not gloss or len(wk_senses[w]) >= 12:
        continue
    shown = " ".join(sorted(t for t in tags if t in SHOW_TAGS))
    wk_senses[w].append([WK_POS.get(wpos, "name" if not exact else wpos), gloss, "", shown])
    wk_old[w][1] += 1
    if tags & OLD_TAGS:
        wk_old[w][0] += 1
    if tags & SENSITIVE_TAGS:
        wk_sensitive.add(w)

for w, rel_name, table, col in [(None, "syn", "synonyms", "synonym_word"), (None, "ant", "antonyms", "antonym_word")]:
    extra = defaultdict(list)
    for word, other in wk.execute(f"SELECT e.word, t.{col} FROM {table} t JOIN entries e ON e.id = t.entry_id"):
        a, b = word.lower(), other.lower()
        if a in wid and b in wid and a != b:
            extra[a].append(b)
    for a, lst in extra.items():
        e = entries.setdefault(a, {})
        r = e.setdefault("r", {})
        r[rel_name] = dedupe(r.get(rel_name, []) + lst, (a,))

def norm_gloss(g):
    return re.sub(r"[^a-z ]", "", g.lower())[:40]

n_new = 0
for w, sl in wk_senses.items():
    i = wid[w]
    e = entries.setdefault(w, {})
    for sense in sl:
        if sense[0] in POS_BIT:
            pos[i] |= POS_BIT[sense[0]]
    if "s" in e:
        known = {norm_gloss(x[1]) for x in e["s"]}
        sl = [x for x in sl if norm_gloss(x[1]) not in known and x[0] != "name"][:8]
    else:
        n_new += 1
        if any(x[0] != "name" for x in sl):
            sl = [x for x in sl if x[0] != "name"]  # a place called "Lucid" adds nothing once "lucid" has senses
    if sl:
        e["x"] = [x if x[3] else x[:2] for x in sl]
        flags[i] |= F_DEF
    old, total = wk_old[w]
    if total and old == total and "s" not in e:
        flags[i] |= F_ARCHAIC
    if w in wk_sensitive:
        flags[i] |= F_SENSITIVE
# negated forms ("unglowing", "beamless") embed right next to their opposites; flag them for down-ranking
for w, e in entries.items():
    glosses = [x[1] for x in e.get("s", []) + e.get("x", [])]
    if glosses and NEG_SHAPE.match(w) and (NEG_GLOSS.match(glosses[0]) or sum(bool(NEG_GLOSS.match(g)) for g in glosses) * 2 > len(glosses)):
        flags[wid[w]] |= F_NEGATED

log("wiktionary: senses for", len(wk_senses), "words,", n_new, "not in WordNet;", len(wk_form_of), "form-of links")

# ---------------------------------------------------------------- inflections

MORPH_POS = [("n", 1), ("v", 2), ("a", 4), ("r", 8)]


def rule_base(w):
    """Suffix rules for words WordNet does not know (e.g. 'aahed' -> 'aah')."""
    cands = []
    if w.endswith("ies") and len(w) > 4:
        cands.append(w[:-3] + "y")
    if w.endswith("es") and len(w) > 3:
        cands.append(w[:-2])
    if w.endswith("s") and not w.endswith("ss") and len(w) > 3:
        cands.append(w[:-1])
    for suf in ("ed", "ing"):
        if w.endswith(suf) and len(w) > len(suf) + 2:
            stem = w[: -len(suf)]
            cands += [stem, stem + "e"]
            if len(stem) > 2 and stem[-1] == stem[-2]:
                cands.append(stem[:-1])
            if stem.endswith("i"):
                cands.append(stem[:-1] + "y")
    return next((c for c in cands if c in wid and c != w), None)


n_infl = 0
for w, i in wid.items():
    base, bpos = None, 0
    for p, bit in MORPH_POS:
        for b in wn._morphy(w, p):
            if b != w and b in wid:
                base = base or b
                bpos |= bit
    if base and w not in lower_lemma:
        flags[i] |= F_INFL
        pos[i] |= bpos
        entries.setdefault(w, {})["b"] = base
        n_infl += 1
    elif not (flags[i] & F_DEF) and not base:
        b = wk_form_of.get(w) or rule_base(w)
        if b:
            flags[i] |= F_INFL
            pos[i] |= pos[wid[b]]
            entries.setdefault(w, {})["b"] = b
            n_infl += 1
log("inflections", n_infl)

# proper nouns and abbreviations: only ever capitalised in the source list, never a lower-case lemma
# The casing in words.txt is noisy for common words ("Had", "OF"), so frequent words need corroboration.
upper_lemma = {lem.name().lower() for ss in wn.all_synsets("n") for lem in ss.lemmas() if lem.name()[0].isupper()}
for w, i in wid.items():
    if w in lower_seen or w in lower_lemma or flags[i] & F_INFL:
        continue
    if w in upper_seen and w not in cap_seen:
        if zipf[i] < 35:
            flags[i] |= F_ABBR
    elif (w in cap_seen or w in upper_seen) and (w in upper_lemma or zipf[i] < 35):
        flags[i] |= F_PROPER
    elif wk_pos_names.get(w) == {"name"}:
        flags[i] |= F_PROPER

# ---------------------------------------------------------------- spelling variants

for line in read_lines(os.path.join(INPUT, "uk-us-dict.txt"))[1:]:
    parts = line.split()
    if len(parts) != 2:
        continue
    uk, us = parts
    if uk in wid and us in wid:
        flags[wid[uk]] |= F_VARIANT
        flags[wid[us]] |= F_VARIANT
        entries.setdefault(uk, {})["v"] = us
        entries.setdefault(us, {})["v"] = uk

for w, (p, st) in ipa.items():
    e = entries.setdefault(w, {})
    e["p"] = p
    e["st"] = st

# ---------------------------------------------------------------- vectors

glove_npy = os.path.join(CACHE, "glove-300.npz")
if not os.path.exists(glove_npy):
    log("parsing GloVe")
    toks, vecs = [], []
    with gzip.open(os.path.join(CACHE, "glove-300.gz"), "rt", encoding="utf-8") as f:
        next(f)
        for k, line in enumerate(f):
            if k >= 250_000:
                break
            t, rest = line.split(" ", 1)
            if not t.isalpha() or not t.isascii():
                continue
            toks.append(t)
            vecs.append(np.array(rest.split(), dtype=np.float32))
    np.savez(glove_npy, toks=np.array(toks), vecs=np.stack(vecs))
z = np.load(glove_npy)
g_toks = list(z["toks"])
G = z["vecs"].astype(np.float32)
g_rank = {t: r for r, t in enumerate(g_toks)}
log("GloVe", G.shape)

# "All-but-the-top" (Mu & Viswanath 2018): remove the mean and dominant directions, then PCA down to DIM.
G -= G[:50_000].mean(0)
_, _, Vt = np.linalg.svd(G[:50_000], full_matrices=False)
top = Vt[:3]
G -= (G @ top.T) @ top
_, _, Vt = np.linalg.svd(G[:50_000], full_matrices=False)
G = G @ Vt[:DIM].T
G /= np.linalg.norm(G, axis=1, keepdims=True) + 1e-9
log("reduced to", G.shape)

TOKEN = re.compile(r"[a-z]+")
STOP = set("""a an the of or and to in on for with by as at from that which who whom whose is are was were be been
being it its this these those into onto than such not no any some something someone esp especially usually often
used use one ones having has have etc e g i synonym alternative spelling form variant relating pertaining
manner state quality obsolete archaic dated rare""".split())


def sif(t):
    return 1e-4 / (1e-4 + freq.get(t, 1e-7))


def definition_vector(w):
    e = entries.get(w)
    senses = (e or {}).get("s", []) + (e or {}).get("x", [])
    if not senses:
        return None
    acc = np.zeros(DIM, np.float32)
    total = 0.0
    for k, sense in enumerate(senses[:8]):
        wk = 1.0 / (1 + k)
        for t in TOKEN.findall(sense[1].lower()):
            r = g_rank.get(t)
            if r is None or t in STOP or t == w:
                continue
            a = wk * sif(t)
            acc += a * G[r]
            total += a
    for t in e.get("r", {}).get("syn", [])[:8]:
        r = g_rank.get(t)
        if r is not None:
            a = 0.6 * sif(t)
            acc += a * G[r]
            total += a
    if total == 0:
        return None
    return acc / total


def_ids, def_vecs = [], []
for w in entries:
    v = definition_vector(w)
    if v is not None:
        def_ids.append(wid[w])
        def_vecs.append(v)
D = np.stack(def_vecs)
# SIF common-component removal
_, _, Vt = np.linalg.svd(D - D.mean(0), full_matrices=False)
D -= D.mean(0)
D -= (D @ Vt[:1].T) @ Vt[:1]
D /= np.linalg.norm(D, axis=1, keepdims=True) + 1e-9
def_row = {i: k for k, i in enumerate(def_ids)}
log("definition vectors", D.shape)

vec_ids, vec_rows = [], []
for w, i in wid.items():
    r = g_rank.get(w)
    g = G[r] if r is not None and r < GLOVE_MAX_RANK else None
    d = D[def_row[i]] if i in def_row else None
    if g is None and d is None:
        continue
    if g is not None and d is not None:
        # trust the co-occurrence vector for frequent words, lean on the definition for rarer ones
        alpha = 0.72 if r < 20_000 else 0.6 if r < 60_000 else 0.45
        v = alpha * g + (1 - alpha) * d
    else:
        v = g if g is not None else d
        if g is None:
            flags[i] |= F_DEFVEC  # meaning known only through its definition: sits close to concept centroids
    v = v / (np.linalg.norm(v) + 1e-9)
    vec_ids.append(i)
    vec_rows.append(v)
V = np.stack(vec_rows).astype(np.float32)
assert np.isfinite(V).all(), "non-finite values in meaning vectors"
for i in vec_ids:
    flags[i] |= F_VEC
log("meaning vectors", V.shape)

if "--probe" in sys.argv:
    row = {i: k for k, i in enumerate(vec_ids)}
    for w in ["light", "ocean", "swift", "lumen", "brave", "north", "craft", "gentle", "forge", "kin", "luminous",
              "sparrow", "ember", "vellum", "quiet"]:
        if w not in wid or wid[w] not in row:
            print(w, "-")
            continue
        s = V @ V[row[wid[w]]]
        s = s * np.where(flags[np.array(vec_ids)] & F_NEGATED, 0.8, 1.0)
        top = np.argsort(-s)[1:16]
        print(f"{w:10s}", " ".join(words[vec_ids[k]] for k in top))
    sys.exit(0)

# ---------------------------------------------------------------- write

os.makedirs(os.path.join(OUT, "defs"), exist_ok=True)
with open(os.path.join(OUT, "words.txt"), "w") as f:
    f.write("\n".join(words))
with open(os.path.join(OUT, "meta.bin"), "wb") as f:
    for arr in (flags, zipf, syl, pos):
        f.write(arr.astype(arr.dtype.newbyteorder("<")).tobytes())
with open(os.path.join(OUT, "phon.txt"), "w") as f:
    f.write("\n".join(phon_lines))

shards = defaultdict(dict)
for w in sorted(entries):
    shards[w[0]][w] = entries[w]
for letter, d in shards.items():
    with open(os.path.join(OUT, "defs", f"{letter}.json"), "w") as f:
        json.dump(d, f, separators=(",", ":"), ensure_ascii=False)

Q = np.clip(np.round(V * 127), -127, 127).astype(np.int8)
with open(os.path.join(OUT, "vectors.bin"), "wb") as f:
    f.write(Q.tobytes())
with open(os.path.join(OUT, "vector_ids.bin"), "wb") as f:
    f.write(np.array(vec_ids, dtype=np.uint32).tobytes())

manifest = {
    "version": 1,
    "built": time.strftime("%Y-%m-%d"),
    "count": N,
    "vectors": {"count": len(vec_ids), "dim": DIM},
    "meta": [["flags", "u16"], ["zipf10", "u8"], ["syllables", "u8"], ["pos", "u8"]],
    "pos": {"n": 1, "v": 2, "a": 4, "r": 8},
    "flags": {"def": F_DEF, "vec": F_VEC, "proper": F_PROPER, "abbr": F_ABBR, "infl": F_INFL, "pron": F_PRON,
              "variant": F_VARIANT, "taxon": F_TAXON,
              "archaic": F_ARCHAIC, "sensitive": F_SENSITIVE, "negated": F_NEGATED,
              "defvec": F_DEFVEC},
    "phonemes": {"vowels": {PH_CODE[p]: p for p in ARPA_VOWELS}, "consonants": {PH_CODE[p]: p for p in ARPA_CONS}},
    "sources": ["english-words (dwyl, Unlicense)", "WordNet 3.0 (Princeton)", "CMU Pronouncing Dictionary",
                "wordfreq (Speer)", "GloVe 6B 300d (Pennington et al.)",
                "English Wiktionary (CC BY-SA 4.0, via cstr/en-wiktionary-sqlite-full)"],
}
with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)

counts = {k: int(((flags & v) > 0).sum()) for k, v in manifest["flags"].items()}
log("done", counts)
