"""Build the offline dictionary and HSK level table.

python3 -I tools/build_dict.py <cedict.txt.gz> <hsk_dir_with_1..6.json> <out_dir>
Writes dict.json (CC-CEDICT, CC BY-SA 4.0, MDBG) and levels.json (HSK 3.0 level per word,
from drkameleon/complete-hsk-vocabulary).
"""
import gzip, json, re, sys
from pathlib import Path

ced, hskdir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
TONES = {"a": "āáǎàa", "e": "ēéěèe", "i": "īíǐìi", "o": "ōóǒòo", "u": "ūúǔùu", "ü": "ǖǘǚǜü"}

def mark(syl):
    m = re.match(r"([a-zü:]+)([1-5])$", syl.lower().replace("u:", "ü"))
    if not m:
        return syl.replace("u:", "ü")
    s, t = m.group(1), int(m.group(2))
    if t == 5:
        return s
    for v in ("a", "e"):
        if v in s:
            return s.replace(v, TONES[v][t - 1], 1)
    if "ou" in s:
        return s.replace("o", TONES["o"][t - 1], 1)
    for i in range(len(s) - 1, -1, -1):
        if s[i] in TONES:
            return s[:i] + TONES[s[i]][t - 1] + s[i + 1:]
    return s

d = {}
for line in gzip.open(ced, "rt", encoding="utf-8"):
    if line.startswith("#"):
        continue
    m = re.match(r"(\S+) (\S+) \[([^\]]+)\] /(.+)/", line)
    if not m:
        continue
    simp, py, defs = m.group(2), m.group(3), m.group(4).split("/")
    if len(simp) > 6:
        continue
    defs = [x for x in defs if not x.startswith(("variant of", "old variant", "see ", "CL:", "Taiwan pr."))] or defs
    pinyin = " ".join(mark(s) for s in py.split())
    gloss = "; ".join(defs[:3])[:90]
    if simp in d:
        if len(d[simp]) < 3:  # keep up to 3 readings
            d[simp].append(pinyin + "|" + gloss)
    else:
        d[simp] = [pinyin + "|" + gloss]

levels = {}
for n in range(1, 7):
    for w in json.loads((hskdir / f"{n}.json").read_text("utf-8")):
        levels.setdefault(w["s"], n)

out.mkdir(parents=True, exist_ok=True)
(out / "dict.json").write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), "utf-8")
(out / "levels.json").write_text(json.dumps(levels, ensure_ascii=False, separators=(",", ":")), "utf-8")
print("dict entries", len(d), "levels", len(levels), {n: sum(1 for v in levels.values() if v == n) for n in range(1, 7)})
