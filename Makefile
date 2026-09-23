# Wordable — word explorer for naming work.
#   make data    build the browser data bundle (downloads sources on first run, ~1.4 GB)
#   make serve   run the app at http://localhost:8765

PY      := .venv/bin/python
CACHE   := data/cache
PORT    ?= 8765

.PHONY: data serve deps clean-cache

serve:
	@echo "Wordable → http://localhost:$(PORT)"
	@python3 -m http.server $(PORT) --directory app --bind 127.0.0.1

data: deps $(CACHE)/glove-300.gz $(CACHE)/wiktionary.db $(CACHE)/nltk_data
	$(PY) scripts/build_data.py

deps: .venv/.ok
.venv/.ok: scripts/requirements.txt
	python3 -m venv .venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -r scripts/requirements.txt
	touch $@

$(CACHE)/nltk_data: | deps
	mkdir -p $(CACHE)
	$(PY) -c "import nltk; [nltk.download(p, download_dir='$(CACHE)/nltk_data', quiet=True) for p in ('wordnet', 'omw-1.4', 'cmudict')]"

$(CACHE)/glove-300.gz:
	mkdir -p $(CACHE)
	curl -L --fail -o $@ https://github.com/RaRe-Technologies/gensim-data/releases/download/glove-wiki-gigaword-300/glove-wiki-gigaword-300.gz

$(CACHE)/wiktionary.db:
	mkdir -p $(CACHE)
	curl -L --fail -o $@.gz "https://huggingface.co/datasets/cstr/en-wiktionary-sqlite-full/resolve/main/en_wiktionary_normalized_full.db.gz"
	gunzip -f $@.gz
	sqlite3 $@ "CREATE INDEX IF NOT EXISTS ix_s_entry ON senses(entry_id); CREATE INDEX IF NOT EXISTS ix_g_sense ON glosses(sense_id); CREATE INDEX IF NOT EXISTS ix_st ON sense_tags(sense_id);"

clean-cache:
	rm -rf $(CACHE)
