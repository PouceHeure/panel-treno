#!/usr/bin/env python3
"""Stamps every local script and stylesheet of the HTML pages with a hash of its content: js/app.js?v=3fa9c1d2.

A browser keeps its copy of a file until the address changes; the hash changes with the file, so a visitor
never runs yesterday's CSS with today's HTML. Run it after editing any asset (the tests fail if you forget):

    python3 scripts/stamp-assets.py          # rewrite the pages
    python3 scripts/stamp-assets.py --check  # only report; exit 1 when a page is out of date
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = sorted(ROOT.glob('*.html'))
REF = re.compile(r'''((?:src|href)=")((?:js|css)/[^"?]+)(?:\?v=[0-9a-f]+)?(")''')


def digest(relative):
    return hashlib.sha1((ROOT / relative).read_bytes()).hexdigest()[:8]


def stamped(text):
    return REF.sub(lambda m: f'{m.group(1)}{m.group(2)}?v={digest(m.group(2))}{m.group(3)}', text)


def main(argv):
    stale = []
    for page in PAGES:
        text = page.read_text()
        new = stamped(text)
        if new != text:
            stale.append(page.name)
            if '--check' not in argv:
                page.write_text(new)
    if '--check' in argv:
        if stale:
            print('out of date:', ', '.join(stale), '(run scripts/stamp-assets.py)')
            return 1
        print('assets stamped')
        return 0
    print('stamped:', ', '.join(stale) if stale else 'nothing to change')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
