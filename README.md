# Wordable

A fast, minimal word explorer for naming work — companies, products, anything. All 370,105 words of
[dwyl/english-words](https://github.com/dwyl/english-words), enriched with definitions, pronunciation,
frequency and a meaning space, so you can browse, filter, find neighbours, and keep shortlists.

```sh
make serve        # → http://localhost:8765
```

No build step and no dependencies at runtime: plain HTML, CSS and ES modules, with the engine in a Web Worker.
The data bundle in `app/data/` is already built.

## What it does

**Explore** — every word, virtualised, in three views: *Grid* (dense columns), *List* (receipt rows with the
first definition), *Type* (large specimens). Group by letter, length, syllables, frequency or part of speech;
sort A–Z, by commonness, length, syllables, ending (rhyme order), shuffled, or best match.

**Search** — starts / has / ends, wildcards (`lu*`, `?ex`), regular expressions (`/^[aeiou].{4}$/`), or
*Defs* to search inside definitions (`bright light` finds *lambent*, *lucent*, *aglow*…).

**Filters** apply everywhere (Explore, Cloud and the word panel's neighbours): length, syllables, frequency
(Zipf scale), part of speech, letters to include/exclude, shape (pronounceable, no repeated letters, starts/ends
with a vowel, palindromes, double letters), and hiding names, abbreviations, inflections, Latin taxa, archaic,
offensive and negated words. Presets: *All*, *Dictionary*, *Everyday*, *Brandable*.

**Cloud** — the proximity engine. Add seed words; pull toward some (+) and push away from others (−).
Rank by *Meaning* (a GloVe space where rare words are placed by their definitions), *Sound* (phoneme edit
distance, rhyme and alliteration from CMUdict), *Spelling* (shared letter sequences, roots, affixes), or any mix.
Lean toward familiar or obscure words. Show it as a typographic cloud, as clusters of senses (k-means over the
results), or as a ranked list. With two or more seeds you also get coined *blends*.

**Word panel** — pronunciation (IPA), stress pattern, syllables, frequency, definitions (WordNet + Wiktionary,
with usage labels like *archaic* or *derogatory*), thesaurus relations, computed neighbours (meaning, sound,
rhymes, spelling, anagrams, longer words containing it), a type specimen, notes, and look-up links
(etymology, dictionaries, domain search).

**Lists** — as many as you like (one per project). Save with `S` or the dot beside a word; notes, 1–3 star
ratings, drag to reorder (or `Alt+↑/↓`), specimen view for side-by-side comparison, paste in your own coinages,
export `.txt` / `.csv` / `.json`, print, and back up / restore everything. Lists live in your browser's
localStorage — use *Back up all* to keep a copy.

Everything is linkable: filters, the open word and cloud seeds live in the URL, and back/forward work.
Follows the system light/dark setting (override with *Auto / Light / Dark*). Press `?` for shortcuts.

## Data

| | Source | License |
|---|---|---|
| Word list | [dwyl/english-words](https://github.com/dwyl/english-words) `words_alpha.txt`, casing from `words.txt`, `uk-us-dict.txt` | Unlicense |
| Definitions, thesaurus | [Princeton WordNet 3.0](https://wordnet.princeton.edu/) via NLTK | WordNet License |
| Definitions, usage labels, forms | English Wiktionary via [cstr/en-wiktionary-sqlite-full](https://huggingface.co/datasets/cstr/en-wiktionary-sqlite-full) | CC BY-SA 4.0 |
| Pronunciation | [CMU Pronouncing Dictionary](http://www.speech.cs.cmu.edu/cgi-bin/cmudict) | BSD |
| Frequency | [wordfreq](https://github.com/rspeer/wordfreq) | Apache 2.0 / CC BY-SA 4.0 |
| Meaning space | [GloVe 6B 300d](https://nlp.stanford.edu/projects/glove/) | PDDL |

Because it includes Wiktionary text, the generated bundle in `app/data/` is shared under CC BY-SA 4.0.

Coverage: 195k words with definitions, 204k in the meaning space, 57k with pronunciations, 110k with
frequency counts. That Wiktionary dump has no etymologies and is missing much of the core vocabulary, which
is why WordNet stays primary. For word origins, use the *Etymology* link in the word panel.

## Rebuilding the data

```sh
make data         # creates .venv, downloads sources into data/cache/ (~1.4 GB), writes app/data/ (~73 MB)
```

`scripts/build_data.py` merges the sources into:

- `words.txt`: the vocabulary, sorted; the line number is the word id
- `meta.bin`: per-word flags (Uint16) plus Zipf×10, syllables, and a part-of-speech mask (Uint8 each)
- `phon.txt`: phoneme codes and stress digits per word
- `defs/a.json` … `z.json`: definitions, relations, pronunciation, base forms and variants (loaded per letter)
- `vectors.bin` / `vector_ids.bin`: 128-d int8 unit vectors. GloVe with "all-but-the-top" post-processing and
  PCA; words without a trusted GloVe vector are embedded by SIF-weighted averages of their definitions.

## Layout

```
app/               the site (serve this folder)
  index.html
  css/app.css
  js/main.js       boot, routing, header, shortcuts
  js/worker.js     engine: filtering, sorting, grouping, similarity, clustering, blends
  js/…             state (URL-synced), lexicon, lists, views
  data/            generated bundle
data/input/        source word lists from dwyl/english-words
scripts/           data build
```
