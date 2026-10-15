const test = require('node:test')
const assert = require('node:assert')
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
const { resolvePredictions } = require('../js/modules/prediction-log.js')

const MIN = 60000

test('a prediction closes when the real arrival is known, with the error of each model', () => {
  const pending = { '12-1#3': { k: 1, at: 0, raw: 1000 * MIN + 4 * MIN, model: 1000 * MIN + 1 * MIN } }
  const stops = [{}, {}, {}, { arrivoReale: 1000 * MIN }]
  const closed = resolvePredictions(pending, stops, '12-1')
  assert.strictEqual(closed.length, 1)
  assert.strictEqual(closed[0].rawErrMin, 4)
  assert.strictEqual(closed[0].modelErrMin, 1)
  assert.deepStrictEqual(pending, {})
})

test('nothing closes while the arrival is not real, and other trains are left alone', () => {
  const pending = { '12-1#3': { k: 1, at: 0, raw: 1, model: 1 }, '99-1#3': { k: 1, at: 0, raw: 1, model: 1 } }
  assert.strictEqual(resolvePredictions(pending, [{}, {}, {}, {}], '12-1').length, 0)
  assert.strictEqual(Object.keys(pending).length, 2)
  const stops = [{}, {}, {}, { arrivoReale: 5 * MIN }]
  resolvePredictions(pending, stops, '99-1')
  assert.deepStrictEqual(Object.keys(pending), ['12-1#3'])
})
