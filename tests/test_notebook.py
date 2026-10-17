"""The notebook must keep running: every code cell is executed, on a small made-up export, whenever the tests run."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTEBOOK = ROOT / 'notebooks' / 'model-evaluation.ipynb'

try:
    import matplotlib
    import pandas  # noqa: F401
    import sklearn  # noqa: F401
    matplotlib.use('Agg')
    AVAILABLE = True
except ImportError:
    AVAILABLE = False

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_evaluate import train  # noqa: E402


def made_up_export():
    """Four whole days of trains, late by different amounts, one stretch always slower than the rest."""
    trains = []
    tid = 0
    for day in range(4):
        for i in range(30):
            tid += 1
            trains.append(train(tid, day, (i % 4) * 2, offsets={3: 2}))
    return {'trains': trains, 'exported_at': 1791900000}


class NotebookTest(unittest.TestCase):
    @unittest.skipUnless(AVAILABLE, 'needs pandas, matplotlib and scikit-learn')
    def test_every_code_cell_runs(self):
        nb = json.loads(NOTEBOOK.read_text())
        self.assertEqual(nb['nbformat'], 4)
        ids = [c['id'] for c in nb['cells']]
        self.assertEqual(len(ids), len(set(ids)), 'cell ids are unique')
        with tempfile.TemporaryDirectory() as tmp:
            export = Path(tmp) / 'export.json'
            export.write_text(json.dumps(made_up_export()))
            os.environ['TRENO_EXPORT'] = str(export)
            previous = os.getcwd()
            os.chdir(ROOT / 'notebooks')
            namespace = {'__name__': '__main__'}
            try:
                for i, cell in enumerate(nb['cells']):
                    if cell['cell_type'] != 'code':
                        continue
                    with contextlib.redirect_stdout(io.StringIO()):
                        exec(compile(''.join(cell['source']), f'cell {i}', 'exec'), namespace)  # noqa: S102
            finally:
                os.chdir(previous)
                os.environ.pop('TRENO_EXPORT', None)

    def test_the_notebook_starts_clean(self):
        nb = json.loads(NOTEBOOK.read_text())
        for cell in nb['cells']:
            if cell['cell_type'] == 'code':
                self.assertEqual(cell['outputs'], [], 'outputs are not committed')
                self.assertIsNone(cell['execution_count'])


if __name__ == '__main__':
    unittest.main()
