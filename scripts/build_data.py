#!/usr/bin/env python3
"""Build the LangCards data files (data/*.json).

Sources
  * Tatoeba (https://tatoeba.org) - human translated sentences, CC BY 2.0 FR.
  * Open Multilingual Wordnet 1.4 - Spanish MCR (CC BY 3.0), Italian MultiWordNet
    (CC BY 3.0) and ItalWordNet (ODC-BY 1.0).
  * scripts/core_words.tsv - hand-curated core vocabulary.

Quality rules (the goal is zero wrong cards):
  Sentences  only DIRECT Spanish<->Italian translation links made by people.
             Indirect translations through a third language are NOT used as cards
             (they mix up tu/usted/vosotros, genders, ...).
             Sentences flagged by Tatoeba reviewers (any "@..." tag) are dropped.
             Sentences written by owners who self-report a level below 4 in that
             language are dropped unless a reviewer tagged them "OK".
  Words      a Spanish->Italian word pair is kept only when BOTH independent sources
             agree: the two words share a meaning (synset) in the wordnets AND they are
             among each other's top-3 most associated words in aligned sentences.
             Inflected forms and gender-mismatched pairs (hija -> figlio) are dropped.
  Articles   Italian/Spanish articles are only shown when the corpus evidence is
             unambiguous (>= 3 occurrences and >= 85 % agreement).

Usage
  pip install -r scripts/requirements.txt
  python3 scripts/build_data.py --download      # fetches raw files into ./raw
  python3 scripts/build_data.py                 # rebuilds data/*.json from ./raw
"""
import argparse
import bz2
import collections
import datetime
import hashlib
import json
import os
import re
import shutil
import sys
import unicodedata
import urllib.request
import zipfile

import simplemma
from wordfreq import tokenize, zipf_frequency

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TATOEBA = "https://downloads.tatoeba.org/exports/per_language"
OMW_URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/omw-1.4.zip"
PIVOTS = ["eng", "fra", "por", "deu", "epo", "rus", "ber", "tur", "heb", "jpn",
          "ukr", "nld", "pol", "cmn", "hun", "fin", "lat"]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- download
def download(raw):
    os.makedirs(raw, exist_ok=True)
    files = [f"spa/spa_sentences_detailed.tsv.bz2", f"ita/ita_sentences_detailed.tsv.bz2",
             f"spa/spa-ita_links.tsv.bz2", f"spa/spa_tags.tsv.bz2", f"ita/ita_tags.tsv.bz2",
             f"spa/spa_user_languages.tsv.bz2", f"ita/ita_user_languages.tsv.bz2"]
    for p in PIVOTS:
        files += [f"spa/spa-{p}_links.tsv.bz2", f"ita/ita-{p}_links.tsv.bz2"]
    for f in files:
        name = os.path.basename(f)
        dst = os.path.join(raw, name[:-4])
        if os.path.exists(dst):
            continue
        log("downloading", f)
        with urllib.request.urlopen(f"{TATOEBA}/{f}") as r, open(dst, "wb") as out:
            out.write(bz2.decompress(r.read()))
    if not os.path.exists(os.path.join(raw, "omw", "omw-1.4")):
        log("downloading OMW 1.4")
        zpath = os.path.join(raw, "omw-1.4.zip")
        with urllib.request.urlopen(OMW_URL) as r, open(zpath, "wb") as out:
            shutil.copyfileobj(r, out)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(os.path.join(raw, "omw"))


# --------------------------------------------------------------------------- loading
def read_tsv(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            yield line.rstrip("\n").split("\t")


def load_sentences(raw, lang):
    out = {}
    for r in read_tsv(os.path.join(raw, f"{lang}_sentences_detailed.tsv")):
        if len(r) < 4:
            continue
        out[int(r[0])] = (clean_text(r[2]), r[3])
    return out


def load_levels(raw, lang):
    out = {}
    for r in read_tsv(os.path.join(raw, f"{lang}_user_languages.tsv")):
        if len(r) >= 3 and r[0] == lang:
            out[r[2]] = r[1]
    return out


def load_tags(raw, lang):
    out = collections.defaultdict(set)
    for r in read_tsv(os.path.join(raw, f"{lang}_tags.tsv")):
        if len(r) == 2:
            out[int(r[0])].add(r[1])
    return out


def load_links(raw, name):
    """Return list of (left_id, right_id) for e.g. spa-ita_links.tsv."""
    out = []
    for r in read_tsv(os.path.join(raw, f"{name}_links.tsv")):
        if len(r) == 2:
            out.append((int(r[0]), int(r[1])))
    return out


def clean_text(t):
    t = unicodedata.normalize("NFC", t).strip()
    t = t.replace(" ", " ").replace(" ", " ")
    t = re.sub(r"\s+", " ", t)
    return t


# --------------------------------------------------------------------------- text helpers
WORD_RE = re.compile(r"[a-záéíóúüñàèìòùçâêîôûäëïö]+", re.I)
IT_TOKEN_RE = re.compile(r"[a-zàèéìíîòóùú]+'|[a-zàèéìíîòóùú]+", re.I)


def words(text):
    return WORD_RE.findall(text.lower())


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def norm_key(s):
    s = strip_accents(s.lower().replace("’", "'"))
    return re.sub(r"[^a-z0-9']+", " ", s).strip()


LETTERS_OK = re.compile(r"^[\w\s¡!¿?.,;:'’\"«»“”()\-–—…%€$/&ºª°+=]+$", re.U)


def plausible(text):
    if not (1 <= len(text) <= 160):
        return False
    if not LETTERS_OK.match(text):
        return False
    # Latin script only
    for ch in text:
        if ch.isalpha() and not ("LATIN" in unicodedata.name(ch, "")):
            return False
    return bool(words(text))


def has_unknown_word(text, lang):
    """True if the sentence contains a lowercase word that does not exist in the
    language's frequency lexicon - almost always a typo (e.g. "terrorizata").
    Capitalised words after the first position are treated as names and allowed."""
    toks = text.split()
    caps = {strip_punct(t).lower() for t in toks[1:] if t[:1].isupper()}
    for t in tokenize(text, lang):
        if not t.isalpha() or t in caps:
            continue
        if zipf_frequency(t, lang) == 0:
            return True
    return False


def strip_punct(t):
    return re.sub(r"^[^\w]+|[^\w]+$", "", t)


# --------------------------------------------------------------------------- sentences
def build_sentences(raw):
    S = load_sentences(raw, "spa")
    I = load_sentences(raw, "ita")
    LS, LI = load_levels(raw, "spa"), load_levels(raw, "ita")
    TS, TI = load_tags(raw, "spa"), load_tags(raw, "ita")
    links = load_links(raw, "spa-ita")
    log(f"tatoeba: {len(S)} spa, {len(I)} ita sentences, {len(links)} direct links")

    def ok(sid, table, levels, tags):
        if sid not in table:
            return False
        text, owner = table[sid]
        t = tags.get(sid, set())
        if any(x.startswith("@") for x in t):
            return False
        if not plausible(text):
            return False
        if has_unknown_word(text, "es" if table is S else "it"):
            return False
        lvl = levels.get(owner)
        reviewed = "OK" in t
        if lvl in ("0", "1", "2", "3") and not reviewed:
            return False
        return True

    stats = collections.Counter()
    good = []
    for a, b in links:
        if not ok(a, S, LS, TS):
            stats["drop_spa"] += 1
            continue
        if not ok(b, I, LI, TI):
            stats["drop_ita"] += 1
            continue
        if norm_key(S[a][0]) == norm_key(I[b][0]):
            stats["drop_identical"] += 1
            continue
        good.append((a, b))
    log("sentence filter:", dict(stats), "kept", len(good))

    # Sentences that differ only in case/punctuation/accents (e.g. "perche" vs "perché")
    # are merged into one canonical sentence. The canonical one is the most established:
    # reviewer "OK" tag first, then the number of translations it has on Tatoeba.
    # A question never merges with a statement ("Parla." vs "Parla?").
    linkcount = collections.Counter()
    for lang in ("spa", "ita"):
        for p in PIVOTS + (["ita"] if lang == "spa" else []):
            for x, _ in load_links(raw, f"{lang}-{p}"):
                linkcount[(lang, x)] += 1

    def canon_map(ids, table, tags, lang):
        groups = collections.defaultdict(list)
        for i in ids:
            t = table[i][0]
            groups[norm_key(t) + ("?" if "?" in t else "")].append(i)
        m = {}
        for g in groups.values():
            best = max(g, key=lambda i: ("OK" in tags.get(i, ()), linkcount[(lang, i)], -i))
            for i in g:
                m[i] = best
        return m

    cs = canon_map({a for a, _ in good}, S, TS, "spa")
    cit = canon_map({b for _, b in good}, I, TI, "ita")
    dedup = sorted({(cs[a], cit[b]) for a, b in good})
    log("after merging duplicate sentences", len(dedup))
    return S, I, dedup


def it_difficulty(text):
    ws = words(text)
    if not ws:
        return 99.0
    rar = [max(0.0, 7.0 - zipf_frequency(w, "it")) for w in ws]
    return len(ws) * 1.0 + 1.6 * (sum(rar) / len(rar)) + 0.6 * max(rar)


def levels_by_quantile(scores, n=5):
    """scores: dict id->score. Returns id->level (1..n) by quantiles."""
    order = sorted(scores, key=lambda k: scores[k])
    out = {}
    for i, k in enumerate(order):
        out[k] = min(n, 1 + (i * n) // max(1, len(order)))
    return out


# --------------------------------------------------------------------------- co-occurrence
def pivot_pairs(raw):
    """Indirect es-it pairs through other languages. Used ONLY as statistical evidence
    for word alignment, never shown as translation cards."""
    cand = set()
    for p in PIVOTS:
        s = collections.defaultdict(set)
        for a, piv in load_links(raw, f"spa-{p}"):
            s[piv].add(a)
        i = collections.defaultdict(set)
        for b, piv in load_links(raw, f"ita-{p}"):
            i[piv].add(b)
        for piv in s.keys() & i.keys():
            for a in s[piv]:
                for b in i[piv]:
                    cand.add((a, b))
    return cand


class Lemmatizer:
    def __init__(self, lang):
        self.lang = lang
        self.cache = {}

    def __call__(self, w):
        r = self.cache.get(w)
        if r is None:
            r = simplemma.lemmatize(w, lang=self.lang).lower()
            self.cache[w] = r
        return r

    def bag(self, text):
        out = set()
        for w in words(text):
            out.add(w)
            out.add(self(w))
        return out


def cooccurrence(S, I, direct, pivots, lem_es, lem_it):
    pairs = set(direct) | pivots
    direct = set(direct)
    BE, BI = {}, {}
    ce, ci, cp = collections.Counter(), collections.Counter(), collections.Counter()
    for a, b in pairs:
        if a not in S or b not in I:
            continue
        if a not in BE:
            BE[a] = lem_es.bag(S[a][0])
        if b not in BI:
            BI[b] = lem_it.bag(I[b][0])
        w = 1.0 if (a, b) in direct else 0.5
        for x in BE[a]:
            ce[x] += w
        for y in BI[b]:
            ci[y] += w
        for x in BE[a]:
            for y in BI[b]:
                cp[(x, y)] += w
    return ce, ci, cp, BE, BI


# --------------------------------------------------------------------------- words
def load_omw(raw, sub, fname):
    d = collections.defaultdict(set)
    for r in read_tsv(os.path.join(raw, "omw", "omw-1.4", sub, fname)):
        if not r or r[0].startswith("#") or len(r) < 3 or not r[1].endswith("lemma"):
            continue
        d[r[0]].add(clean_text(r[2]))
    return d


POS_MAP = {"n": "n", "v": "v", "a": "adj", "s": "adj", "r": "adv"}
BLOCK_IT = {"negro", "negra", "frocio", "culo", "cazzo", "puttana", "troia", "stronzo", "merda"}
BLOCK_ES = {"puta", "maricón", "coño", "mierda", "cabrón", "polla", "culo", "joder"}


def build_words(raw, S, I, ce, ci, cp, lem_es, lem_it):
    es = load_omw(raw, "mcr", "wn-data-spa.tab")
    it = load_omw(raw, "ita", "wn-data-ita.tab")
    for k, v in load_omw(raw, "iwn", "wn-data-ita.tab").items():
        it[k] |= v

    K = 3
    fe, fi = collections.defaultdict(list), collections.defaultdict(list)
    for (a, b), p in cp.items():
        if p < 2:
            continue
        d = 2 * p / (ce[a] + ci[b])
        fe[a].append((d, b))
        fi[b].append((d, a))
    top_e = {a: {b for _, b in sorted(v, reverse=True)[:K]} for a, v in fe.items()}
    top_i = {b: {a for _, a in sorted(v, reverse=True)[:K]} for b, v in fi.items()}

    stats = collections.Counter()
    found = {}  # (a, b) -> {"dice","p","pos":set}
    for syn in es.keys() & it.keys():
        pos = POS_MAP.get(syn[-1])
        for A in es[syn]:
            for B in it[syn]:
                a, b = A.lower(), B.lower()
                if not re.fullmatch(r"[a-záéíóúüñ]+", a) or not re.fullmatch(r"[a-zàèéìíîòóùú]+", b):
                    continue
                if A[0].isupper() != B[0].isupper():
                    continue
                p = cp.get((a, b), 0)
                if p < 2:
                    continue
                d = 2 * p / (ce[a] + ci[b])
                if d < 0.1 or b not in top_e.get(a, ()) or a not in top_i.get(b, ()):
                    continue
                key = (A if A[0].isupper() else a, B if B[0].isupper() else b)
                e = found.setdefault(key, {"dice": d, "p": p, "pos": set()})
                e["pos"].add(pos)
    log("word pairs (both sources agree):", len(found))

    nouns_it = {B.lower() for (A, B), e in found.items() if "n" in e["pos"]}
    nouns_es = {A.lower() for (A, B), e in found.items() if "n" in e["pos"]}
    ev = article_evidence(I, S, nouns_it, nouns_es)
    it_att, es_att = ev[2], ev[3]

    kept = {}
    for (A, B), e in found.items():
        a, b = A.lower(), B.lower()
        if a in BLOCK_ES or b in BLOCK_IT:
            stats["blocked"] += 1
            continue
        if A[0].isupper() and A == B:
            stats["identical_name"] += 1  # "Cuba -> Cuba" teaches nothing
            continue
        # part-of-speech sanity: verbs must be infinitives on both sides; a noun that
        # looks like an infinitive on only one side must be attested after a determiner
        # (drops "pulsar -> pulsante" while keeping "el lugar -> il luogo").
        es_inf = bool(re.search(r"(ar|er|ir|ír)(se)?$", a))
        it_inf = bool(re.search(r"(are|ere|ire|rre)$|rsi$", b))
        pos = set(e["pos"])
        if "v" in pos and not (es_inf and it_inf):
            pos.discard("v")
        if "n" in pos and es_inf != it_inf:
            if (es_inf and es_att[a] < 2) or (it_inf and it_att[b] < 2):
                pos.discard("n")
        if not pos:
            stats["pos_mismatch"] += 1
            continue
        e = dict(e, pos=pos)
        # inflected forms (plurals etc.) are not dictionary entries
        if lem_es(a) != a and a.endswith("s"):
            stats["es_inflected"] += 1
            continue
        # gender mismatch: hija -> figlio, adulta -> adulto
        if a.endswith("a") and b.endswith("o") and zipf_frequency(b[:-1] + "a", "it") >= 2.0:
            stats["gender_mismatch"] += 1
            continue
        if a.endswith("o") and b.endswith("a") and zipf_frequency(b[:-1] + "o", "it") >= 2.0:
            stats["gender_mismatch"] += 1
            continue
        if zipf_frequency(a, "es") < 1.5:
            stats["too_rare"] += 1
            continue
        kept[(A, B)] = e
    log("word filters:", dict(stats), "kept", len(kept))
    return kept, ev[0], ev[1]


# --------------------------------------------------------------------------- articles
IT_M = {"il", "un", "uno", "del", "dello", "al", "allo", "dal", "dallo", "nel", "nello",
        "sul", "sullo", "col", "questo", "quel", "quello", "nessun", "alcun"}
IT_F = {"una", "un'", "della", "alla", "dalla", "nella", "sulla", "colla", "questa",
        "quella", "nessuna", "alcuna"}
ES_EL = {"el", "del", "al"}
ES_LA = {"la"}
VOWELS = "aeiouàèéìíîòóùú"


DET_IT_ANY = IT_M | IT_F | {"l'", "dell'", "all'", "dall'", "nell'", "sull'", "mio", "mia",
                            "tuo", "tua", "suo", "sua", "nostro", "nostra"}
DET_ES_ANY = {"el", "la", "un", "una", "del", "al", "este", "esta", "ese", "esa", "aquel",
              "aquella", "mi", "tu", "su", "nuestro", "nuestra"}


def article_evidence(I, S, it_nouns, es_nouns):
    """Count which determiners precede each noun in the full Tatoeba corpora.
    Returns (it_gender[m,f], es_article[el,la], it_attested, es_attested)."""
    it_c = collections.defaultdict(lambda: [0, 0])
    it_att = collections.Counter()
    for text, _ in I.values():
        toks = IT_TOKEN_RE.findall(text.lower().replace("’", "'"))
        for prev, w in zip(toks, toks[1:]):
            if w in it_nouns:
                if prev in IT_M:
                    it_c[w][0] += 1
                elif prev in IT_F:
                    it_c[w][1] += 1
                if prev in DET_IT_ANY:
                    it_att[w] += 1
    es_c = collections.defaultdict(lambda: [0, 0])
    es_att = collections.Counter()
    for text, _ in S.values():
        toks = words(text)
        for prev, w in zip(toks, toks[1:]):
            if w in es_nouns:
                if prev in ES_EL:
                    es_c[w][0] += 1
                elif prev in ES_LA:
                    es_c[w][1] += 1
                if prev in DET_ES_ANY:
                    es_att[w] += 1
    return it_c, es_c, it_att, es_att


def decide(counts):
    m, f = counts
    tot = m + f
    if tot < 3:
        return None
    if m >= 0.85 * tot:
        return "m"
    if f >= 0.85 * tot:
        return "f"
    return None


def it_article(word, gender):
    w = word.lower()
    if gender is None:
        return None
    if w[0] == "i" and len(w) > 1 and w[1] in VOWELS:
        return "lo" if gender == "m" else "la"
    if w[0] in VOWELS:
        return "l'"
    if w[0] == "h":
        return "l'" if gender == "m" else None
    if gender == "f":
        return "la"
    if (w[0] == "s" and len(w) > 1 and w[1] not in VOWELS) or w[0] in "zxy" or w[:2] in ("gn", "ps", "pn"):
        return "lo"
    return "il"


# --------------------------------------------------------------------------- core list
ARTS_ES = ("el ", "la ", "los ", "las ")
ARTS_IT = ("il ", "lo ", "la ", "i ", "gli ", "le ", "l'")


def split_article(s, arts):
    for a in arts:
        if s.startswith(a) and len(s) > len(a):
            return a.strip(), s[len(a):]
    return None, s


def load_core():
    out = []
    path = os.path.join(ROOT, "scripts", "core_words.tsv")
    for r in read_tsv(path):
        if not r or not r[0] or r[0].startswith("#"):
            continue
        es, its, pos, cat = r[0], r[1], r[2], r[3]
        note = r[4] if len(r) > 4 else ""
        ea, ew = split_article(es, ARTS_ES) if pos == "n" else (None, es)
        tr = []
        for alt in its.split("|"):
            g = None
            m = re.search(r"\[(m|f)\]$", alt)
            if m:
                g = m.group(1)
                alt = alt[: m.start()]
            ia, iw = split_article(alt, ARTS_IT)
            if ia and g is None:
                g = {"il": "m", "lo": "m", "i": "m", "gli": "m", "la": "f", "le": "f"}.get(ia)
            tr.append({"w": iw, "a": ia, "g": g})
        out.append({"es": ew, "ea": ea, "pos": pos, "cat": cat, "note": note, "tr": tr})
    return out


def validate_core(core, ce, ci, cp, lem_es, lem_it):
    """Print core entries whose translation is not strongly supported by the corpus."""
    by_a = collections.defaultdict(list)
    for (a, b), p in cp.items():
        if p >= 1:
            by_a[a].append((2 * p / (ce[a] + ci[b]), b))
    warnings = 0
    for e in core:
        a = e["es"].lower()
        if " " in a or a not in by_a:
            continue
        ranked = [b for _, b in sorted(by_a[a], reverse=True)[:25]]
        for t in e["tr"]:
            b = t["w"].lower()
            if " " in b or "'" in b:
                continue
            if b not in ranked:
                warnings += 1
                log(f"  CHECK core: {a} -> {b}   (corpus top: {', '.join(ranked[:6])})")
    log("core validation warnings:", warnings)


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=os.path.join(ROOT, "raw"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    ap.add_argument("--download", action="store_true")
    args = ap.parse_args()
    if args.download:
        download(args.raw)

    S, I, pairs = build_sentences(args.raw)
    lem_es, lem_it = Lemmatizer("es"), Lemmatizer("it")

    log("computing co-occurrence statistics ...")
    piv = pivot_pairs(args.raw)
    ce, ci, cp, BE, BI = cooccurrence(S, I, pairs, piv, lem_es, lem_it)
    del piv

    # --- sentence levels (by Italian sentence)
    it_ids = sorted({b for _, b in pairs})
    es_ids = sorted({a for a, _ in pairs})
    lv = levels_by_quantile({b: it_difficulty(I[b][0]) for b in it_ids})

    # --- words
    auto, it_ev, es_ev = build_words(args.raw, S, I, ce, ci, cp, lem_es, lem_it)
    core = load_core()
    validate_core(core, ce, ci, cp, lem_es, lem_it)

    by_es = collections.defaultdict(list)
    for (A, B), e in auto.items():
        by_es[A].append((e["dice"], B, e))
    core_keys = {c["es"].lower() for c in core}


    # example sentences index: lemma -> pairs
    ex_es = collections.defaultdict(list)
    pairs_sorted = sorted(pairs, key=lambda ab: (len(words(I[ab[1]][0])), ab))
    for a, b in pairs_sorted:
        for x in BE.get(a, ()):
            ex_es[x].append((a, b))

    def examples(a, b, n=2):
        out = []
        for (sa, sb) in ex_es.get(a.lower(), ()):
            if b.lower() in BI.get(sb, ()):
                out.append([sa, sb])
                if len(out) >= n:
                    break
        return out

    words_out = []
    for ci_, c in enumerate(core):
        ex = []
        for t in c["tr"]:
            if " " not in c["es"] and " " not in t["w"]:
                ex = examples(c["es"], t["w"])
                if ex:
                    break
        words_out.append({
            "es": c["es"], "ea": c["ea"], "pos": c["pos"], "cat": c["cat"], "note": c["note"],
            "tr": [{k: v for k, v in t.items() if v} for t in c["tr"]], "ex": ex, "core": 1,
            "f": zipf_frequency(c["es"], "es"), "_order": ci_,
        })
    for A, lst in by_es.items():
        if A.lower() in core_keys:
            continue
        lst.sort(key=lambda x: -x[0])
        names = {B.lower() for _, B, _ in lst[:3]}
        # "rovine" next to "rovina": keep only the dictionary form
        lst = [x for x in lst[:3] if not (lem_it(x[1].lower()) != x[1].lower() and lem_it(x[1].lower()) in names)]
        tr, pos = [], set()
        for d, B, e in lst:
            t = {"w": B}
            if "n" in e["pos"] and not B[0].isupper():
                g = decide(it_ev[B.lower()])
                if g:
                    t["g"] = g
                    art = it_article(B, g)
                    if art:
                        t["a"] = art
            tr.append(t)
            pos |= e["pos"]
        ea = None
        if "n" in pos and not A[0].isupper():
            g = decide(es_ev[A.lower()])
            ea = {"m": "el", "f": "la"}.get(g)
        p = "n" if "n" in pos else ("v" if "v" in pos else ("adj" if "adj" in pos else "adv"))
        ex = []
        for t in tr:
            ex = examples(A, t["w"])
            if ex:
                break
        w = {"es": A, "pos": p, "tr": tr, "ex": ex, "f": zipf_frequency(A.lower(), "es")}
        if ea:
            w["ea"] = ea
        words_out.append(w)

    # learning order: core words in the curated (teaching) order of core_words.tsv,
    # then everything else from the most to the least frequent Spanish word
    words_out.sort(key=lambda w: (0, w["_order"]) if w.get("core") else (1, -w["f"], w["es"]))
    n = len(words_out)
    for i, w in enumerate(words_out):
        w["lv"] = min(5, 1 + (i * 5) // n)
        w["id"] = i + 1
        del w["f"]
        w.pop("_order", None)
        if not w.get("ea"):
            w.pop("ea", None)
        if not w.get("note"):
            w.pop("note", None)
        if not w.get("cat"):
            w.pop("cat", None)

    # make sure example sentences are part of the sentence set
    used_es = set(es_ids)
    used_it = set(it_ids)
    for w in words_out:
        w["ex"] = [x for x in w["ex"] if x[0] in used_es and x[1] in used_it]

    os.makedirs(args.out, exist_ok=True)
    sentences = {
        "es": [[a, S[a][0]] for a in es_ids],
        "it": [[b, I[b][0], lv[b]] for b in it_ids],
        "links": [[a, b] for a, b in sorted(pairs)],
    }
    words_json = {"words": words_out}

    def dump(name, obj):
        path = os.path.join(args.out, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        return path

    p1 = dump("sentences.json", sentences)
    p2 = dump("words.json", words_json)
    h = hashlib.sha256()
    for p in (p1, p2):
        with open(p, "rb") as f:
            h.update(f.read())
    meta = {
        "version": h.hexdigest()[:12],
        "built": datetime.date.today().isoformat(),
        "counts": {
            "spanish_sentences": len(es_ids),
            "italian_sentences": len(it_ids),
            "sentence_pairs": len(pairs),
            "words": len(words_out),
            "core_words": sum(1 for w in words_out if w.get("core")),
        },
        "sources": [
            {"name": "Tatoeba", "url": "https://tatoeba.org", "license": "CC BY 2.0 FR",
             "use": "sentence pairs (direct human translations only)"},
            {"name": "Multilingual Central Repository 3.0 (Spanish WordNet)",
             "url": "http://adimen.si.ehu.es/web/MCR/", "license": "CC BY 3.0", "use": "word meanings"},
            {"name": "MultiWordNet (Italian)", "url": "http://multiwordnet.fbk.eu", "license": "CC BY 3.0",
             "use": "word meanings"},
            {"name": "ItalWordNet", "url": "http://datahub.io/dataset/iwn", "license": "ODC-BY 1.0",
             "use": "word meanings"},
        ],
    }
    dump("meta.json", meta)
    log("done:", json.dumps(meta["counts"]))


if __name__ == "__main__":
    main()
