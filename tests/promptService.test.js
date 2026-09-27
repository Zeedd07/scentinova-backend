/**
 * Deterministic prompt builders + admin prompt endpoints.
 */
import './helpers/env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from '../src/app.js'
import {
  BRAND_PALETTE,
  classifyNote,
  generateNotePrompt,
  generateProductBackgroundPrompt,
} from '../src/services/promptService.js'
import { startTestDb, clearTestDb, stopTestDb } from './helpers/testDb.js'
import { createAdmin } from './helpers/fixtures.js'

describe('classifyNote', () => {
  it('infers the family from the note name', () => {
    assert.equal(classifyNote('Calabrian Bergamot').family, 'CITRUS')
    assert.equal(classifyNote('Jasmine Sambac').family, 'FLORAL')
    assert.equal(classifyNote('Indian Agarwood').family, 'WOODY')
    assert.equal(classifyNote('Orange Blossom').family, 'FLORAL')
    assert.equal(classifyNote('Pink Pepper').family, 'SPICY')
    assert.equal(classifyNote('Sea Water').family, 'FRESH')
    assert.equal(classifyNote('Rosewood').family, 'WOODY')
  })

  it('falls back to a generic subject for unknown notes, and honours an explicit category', () => {
    const unknown = classifyNote('Moonstone Accord')
    assert.equal(unknown.family, 'OTHER')
    assert.equal(unknown.matched, false)
    assert.match(unknown.subject, /Moonstone Accord/)
    assert.equal(classifyNote('Moonstone Accord', 'MUSK').family, 'MUSK')
  })
})

describe('generateNotePrompt', () => {
  it('is deterministic and follows the section structure', () => {
    const a = generateNotePrompt({ noteName: 'Jasmine Sambac', tier: 'HEART' })
    const b = generateNotePrompt({ noteName: 'Jasmine Sambac', tier: 'HEART' })
    assert.deepEqual(a, b)
    assert.deepEqual(
      a.sections.map((s) => s.key),
      ['SUBJECT', 'MATERIAL', 'COMPOSITION', 'LIGHTING', 'BACKGROUND', 'MOOD', 'STYLE', 'BRAND', 'NEGATIVES', 'ASPECT'],
    )
    assert.equal(a.family, 'FLORAL')
    assert.equal(a.aspectRatio, '1:1')
    for (const hex of Object.values(BRAND_PALETTE)) assert.ok(a.prompt.includes(hex), hex)
    assert.match(a.prompt, /Jasmine Sambac/)
    assert.match(a.prompt, /blooming/)
    assert.match(a.prompt, /Negative prompt: .*perfume bottles/)
    assert.match(a.prompt, /Aspect ratio: 1:1\.$/)
    for (const s of a.sections.slice(0, 8)) assert.match(s.text, /^[A-Z0-9]/, `${s.key} starts with a capital`)
  })

  it('changes material and lighting by family', () => {
    const citrus = generateNotePrompt({ noteName: 'Bergamot' })
    const woody = generateNotePrompt({ noteName: 'Sandalwood' })
    assert.notEqual(citrus.sections[1].text, woody.sections[1].text)
    assert.notEqual(citrus.sections[3].text, woody.sections[3].text)
  })
})

describe('generateProductBackgroundPrompt', () => {
  it('reserves negative space for the chosen placement and excludes bottles', () => {
    const left = generateProductBackgroundPrompt({ productName: 'Oud Royale', notes: ['Oud', 'Saffron'], placement: 'LEFT' })
    assert.match(left.prompt, /left third of the frame as clean negative space/)
    assert.match(left.prompt, /no bottle in the scene/)
    assert.match(left.negativePrompt, /any perfume bottle/)
    assert.equal(left.aspectRatio, '4:5')

    const right = generateProductBackgroundPrompt({ productName: 'Oud Royale', placement: 'RIGHT' })
    assert.match(right.prompt, /right third/)
    const center = generateProductBackgroundPrompt({ productName: 'Oud Royale' })
    assert.match(center.prompt, /exact centre/)
  })

  it('uses custom inputs when given and note families otherwise', () => {
    const custom = generateProductBackgroundPrompt({
      productName: 'Maritime',
      notes: ['Calone', 'Sea Water', 'Musk'],
      surface: 'black basalt',
      lighting: 'blue hour window light',
      colors: 'steel blue with ivory',
      aspectRatio: '16:9',
    })
    assert.equal(custom.family, 'FRESH')
    assert.match(custom.prompt, /black basalt/)
    assert.match(custom.prompt, /Blue hour window light\./)
    assert.match(custom.prompt, /steel blue with ivory/)
    assert.match(custom.prompt, /Aspect ratio: 16:9/)
  })
})

describe('POST /api/admin/prompts/*', () => {
  let app
  let token
  before(async () => {
    await startTestDb()
    app = createApp()
  })
  after(async () => {
    await stopTestDb()
  })
  beforeEach(async () => {
    await clearTestDb()
    ;({ token } = await createAdmin())
  })

  it('returns a note prompt for admins and validates input', async () => {
    const ok = await request(app)
      .post('/api/admin/prompts/note')
      .set('Authorization', `Bearer ${token}`)
      .send({ noteName: 'Taif Rose', tier: 'HEART' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.data.family, 'FLORAL')
    assert.match(ok.body.data.prompt, /Taif rose/)

    const bad = await request(app)
      .post('/api/admin/prompts/note')
      .set('Authorization', `Bearer ${token}`)
      .send({ noteName: '' })
    assert.equal(bad.status, 400)
  })

  it('returns a background prompt', async () => {
    const res = await request(app)
      .post('/api/admin/prompts/background')
      .set('Authorization', `Bearer ${token}`)
      .send({ productName: 'Lunar Leather', notes: ['Leather', 'Amber'], placement: 'RIGHT' })
    assert.equal(res.status, 200)
    assert.match(res.body.data.prompt, /Lunar Leather/)
    assert.match(res.body.data.prompt, /right third/)
  })
})
