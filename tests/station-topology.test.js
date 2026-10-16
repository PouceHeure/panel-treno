const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const T = require('../js/modules/station-topology.js')

test('platform references and labels', () => {
  assert.deepStrictEqual(T.splitRefs('12;13'), ['12', '13'])
  assert.deepStrictEqual(T.splitRefs('1a, 2B'), ['1A', '2B'])
  assert.deepStrictEqual(T.splitRefs(undefined), [])
  assert.strictEqual(T.platformToken('11'), '11')
  assert.strictEqual(T.platformToken('1 Ovest'), '1')
  assert.strictEqual(T.platformToken('14 TRONCO'), '14')
  assert.strictEqual(T.platformToken('IV'), 'IV')
  assert.strictEqual(T.platformToken('–'), '')
})

test('ways become platforms and rails; bus platforms and one-point ways are ignored', () => {
  const ways = [
    { id: 1, tags: { railway: 'platform', ref: '1;2' }, pts: [[44, 8], [44.001, 8.001]] },
    { id: 2, tags: { railway: 'rail', service: 'siding' }, pts: [[44, 8], [44.001, 8]] },
    { id: 3, tags: { railway: 'rail', tunnel: 'yes' }, pts: [[44, 8], [44.002, 8]] },
    { id: 4, tags: { public_transport: 'platform', name: 'Bus stop' }, pts: [[44, 8], [44.001, 8]] },
    { id: 5, tags: { railway: 'rail' }, pts: [[44, 8]] }
  ]
  const t = T.topologyFromWays(ways)
  assert.strictEqual(t.platforms.length, 1)
  assert.deepStrictEqual(t.platforms[0].refs, ['1', '2'])
  assert.strictEqual(t.rails.length, 2)
  assert.strictEqual(t.rails[0].siding, true)
  assert.strictEqual(t.rails[1].tunnel, true)
})

test('track angle follows the rails, whichever way they are drawn', () => {
  const east = [[[0, 0], [100, 0]], [[0, 5], [100, 5]]]
  const eastBack = [[[100, 0], [0, 0]], [[100, 5], [0, 5]]]
  assert.ok(Math.abs(T.trackAngle(east)) < 1e-9)
  assert.ok(Math.abs(T.trackAngle(eastBack)) < 1e-9)
  const diagonal = [[[0, 0], [100, 100]]]
  assert.ok(Math.abs(T.trackAngle(diagonal) - Math.PI / 4) < 1e-9)
})

const file = path.join(__dirname, '../data/topology/S04700.json')
test('Genova Piazza Principe: a layout with its numbered platforms, fitted to the canvas', { skip: !fs.existsSync(file) }, () => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const layout = T.layoutTopology(T.topologyFromWays(data.ways), { width: 1100 })
  assert.ok(layout.platforms.length >= 5)
  assert.ok(layout.height > 100 && layout.height < 2500)
  layout.platforms.forEach(p => p.pts.forEach(([x, y]) => {
    assert.ok(x >= 0 && x <= 1100 && y >= 0 && y <= layout.height, 'a platform point is inside the canvas')
  }))
  // the tracks lie horizontally: the long axis of a platform is much longer across x than across y
  const long = layout.platforms.filter(p => p.length > 250)
  assert.ok(long.length >= 3)
  assert.ok(long.every(p => Math.abs(p.right[0] - p.left[0]) > 2 * Math.abs(p.right[1] - p.left[1])))
  const p13 = T.findPlatform(layout, '13')
  assert.ok(p13 && p13.refs.includes('13'))
  assert.ok(T.findPlatform(layout, '1 Ovest') === null || T.findPlatform(layout, '1 Ovest').refs.includes('1'))
  assert.strictEqual(T.findPlatform(layout, 'zzz'), null)
})

test('trains are placed on their platform, the others are returned', { skip: !fs.existsSync(file) }, () => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const layout = T.layoutTopology(T.topologyFromWays(data.ways))
  const trains = [{ n: 1, p: '13' }, { n: 2, p: '13' }, { n: 3, p: '12' }, { n: 4, p: '99' }, { n: 5, p: '' }]
  const { onPlatform, unplaced } = T.placeTrains(layout, trains, t => t.p)
  const onSame = [...onPlatform.values()].find(list => list.some(t => t.n === 1))
  assert.ok(onSame.some(t => t.n === 2), 'two trains on 13 share the platform')
  assert.deepStrictEqual(unplaced.map(t => t.n).sort(), [4, 5])
})

test('the Overpass answer becomes ways', () => {
  const ways = T.waysFromOverpass([
    { type: 'way', id: 9, tags: { railway: 'platform', ref: '3', ignored: 'x' }, geometry: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] },
    { type: 'node', id: 10 },
    { type: 'way', id: 11, tags: {}, geometry: [{ lat: 1, lon: 2 }] }
  ])
  assert.strictEqual(ways.length, 1)
  assert.deepStrictEqual(ways[0].pts, [[1, 2], [3, 4]])
  assert.strictEqual(ways[0].tags.ignored, undefined)
  assert.ok(T.overpassQuery(44.4, 8.9, 300).includes('around:300,44.4,8.9'))
})
