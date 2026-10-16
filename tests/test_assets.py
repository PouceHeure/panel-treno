import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class AssetsTest(unittest.TestCase):
    def test_every_page_carries_the_current_hash_of_its_assets(self):
        out = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'stamp-assets.py'), '--check'], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)

    def test_every_local_asset_a_page_asks_for_exists(self):
        import re
        for page in ROOT.glob('*.html'):
            for ref in re.findall(r'(?:src|href)="((?:js|css)/[^"?]+)', page.read_text()):
                self.assertTrue((ROOT / ref).exists(), f'{page.name} asks for {ref}')


if __name__ == '__main__':
    unittest.main()
