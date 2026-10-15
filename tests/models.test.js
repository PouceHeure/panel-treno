const test = require('node:test')
const assert = require('node:assert')
const { MODEL_REGISTRY, modelStatus, daysAvailable, beatsBaseline } = require('../js/modules/models.js')

const report = {
  split: { calibration_days: ['a', 'b'], test_day: 'c' },
  readiness: { tables: { needs_days: 7, have_days: 3 }, trees: { needs_days: 14, have_days: 14 } },
  models: { raw: { mae_1_to_6: 3.3 }, 'rules-v2': { mae_1_to_6: 2.9 } }
}
const by = id => MODEL_REGISTRY.find(m => m.id === id)

test('built models are active or available, the others wait for data', () => {
  assert.strictEqual(modelStatus(by('rules-v2'), report, 'model'), 'active')
  assert.strictEqual(modelStatus(by('raw'), report, 'model'), 'available')
  assert.strictEqual(modelStatus(by('tables'), report, 'model'), 'collecting')
  assert.strictEqual(modelStatus(by('trees'), report, 'model'), 'to build')
  assert.strictEqual(modelStatus(by('tables'), null, 'model'), 'collecting')
})

test('days of data come from the report', () => {
  assert.strictEqual(daysAvailable(report), 3)
  assert.strictEqual(daysAvailable(null), 0)
})

test('a model is only recommended when it beats the baseline on the held-out day', () => {
  assert.strictEqual(beatsBaseline(by('rules-v2'), report), true)
  assert.strictEqual(beatsBaseline(by('raw'), report), false)
  assert.strictEqual(beatsBaseline(by('trees'), report), false)
  const worse = { ...report, models: { raw: { mae_1_to_6: 3.0 }, 'rules-v2': { mae_1_to_6: 3.4 } } }
  assert.strictEqual(beatsBaseline(by('rules-v2'), worse), false)
})
