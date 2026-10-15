const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { searchLocalStations, setStationIndexForTests, normalizeText } = require('../js/modules/station-index.js')

setStationIndexForTests(JSON.parse(fs.readFileSync(path.join(__dirname, '../data/stations.json'), 'utf8')))
const top = (q, n = 1) => searchLocalStations(q, { limit: n }).map(r => r.name)

test('exact and partial names', () => {
  assert.strictEqual(top('genova piazza principe')[0], 'GENOVA PIAZZA PRINCIPE')
  assert.strictEqual(top('milano centrale')[0], 'MILANO CENTRALE')
  assert.ok(top('arenz', 3).includes('ARENZANO'))
})

test('accents, case and punctuation do not matter', () => {
  assert.strictEqual(normalizeText("Sant'Ilario  Ligure"), 'sant ilario ligure')
  assert.ok(top('genova brignole', 3).includes('GENOVA BRIGNOLE'))
  assert.ok(top('GENOVA   BRIGNOLE', 3).includes('GENOVA BRIGNOLE'))
})

test('initials and one typo', () => {
  assert.ok(top('genova pp', 5).includes('GENOVA PIAZZA PRINCIPE'))
  assert.ok(top('genova brignol', 3).includes('GENOVA BRIGNOLE'))
  assert.ok(top('milno centrale', 5).includes('MILANO CENTRALE'))
})

test('every word must match, and an empty query finds nothing', () => {
  assert.deepStrictEqual(searchLocalStations('', {}), [])
  assert.deepStrictEqual(searchLocalStations('zzzzqqq', {}), [])
})

test('the boost brings a favourite first', () => {
  const plain = searchLocalStations('genova', { limit: 8 })
  const last = plain[plain.length - 1]
  const boosted = searchLocalStations('genova', { limit: 8, boost: id => (id === last.id ? 10 : 0) })
  assert.strictEqual(boosted[0].id, last.id)
})
