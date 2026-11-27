#!/usr/bin/env python3
"""Check that every file the service worker caches exists, then set sw.js VERSION to a
hash of their contents, so phones pick up a new version whenever anything changes."""
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sw_path = os.path.join(ROOT, "sw.js")
sw = open(sw_path, encoding="utf-8").read()
assets = re.findall(r"'\./([^']*)'", sw.split("const ASSETS = [", 1)[1].split("];", 1)[0])
h = hashlib.sha256()
missing = []
for a in assets:
    path = os.path.join(ROOT, a or "index.html")
    if not os.path.isfile(path):
        missing.append(a)
        continue
    h.update(a.encode())
    with open(path, "rb") as f:
        h.update(f.read())
# every JS module must be listed, otherwise the app breaks offline
js = sorted(f"assets/js/{f}" for f in os.listdir(os.path.join(ROOT, "assets", "js")) if f.endswith(".js"))
unlisted = [f for f in js if f not in assets]
if missing or unlisted:
    sys.exit(f"missing files: {missing}  JS modules not cached: {unlisted}")
version = "lc-" + h.hexdigest()[:10]
sw = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{version}';", sw)
open(sw_path, "w", encoding="utf-8").write(sw)
print(version, f"({len(assets)} files)")
