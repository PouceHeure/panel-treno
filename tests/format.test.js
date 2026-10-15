const test = require('node:test')
const assert = require('node:assert')
const { niceName } = require('../js/modules/format.js')

test('station names read as names', () => {
  assert.strictEqual(niceName('GENOVA PIAZZA PRINCIPE'), 'Genova Piazza Principe')
  assert.strictEqual(niceName('MILANO CENTRALE'), 'Milano Centrale')
  assert.strictEqual(niceName('SANT\'ILARIO LIGURE'), "Sant'Ilario Ligure")
  assert.strictEqual(niceName('ALBENGA-LOANO'), 'Albenga-Loano')
})

test('small words stay small, except at the start', () => {
  assert.strictEqual(niceName('SESTRI LEVANTE DI PONENTE'), 'Sestri Levante di Ponente')
  assert.strictEqual(niceName('DI MARE'), 'Di Mare')
})

test('empty values are safe', () => {
  assert.strictEqual(niceName(''), '')
  assert.strictEqual(niceName(null), '')
})
