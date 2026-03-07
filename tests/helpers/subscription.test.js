import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractFilterExtensions,
  buildPopularityFilter,
  parseNip50PathExtensions,
  applyPathExtensionsToFilter
} from '#helpers/subscription.js'

describe('extractFilterExtensions', () => {
  it('should extract is:spam', () => {
    const filter = { search: 'some query is:spam' }
    const ext = extractFilterExtensions(filter)
    assert.equal(ext.isSpam, true)
    assert.equal(filter.search, 'some query')
  })

  it('should extract is:rising', () => {
    const filter = { search: 'is:rising cats' }
    const ext = extractFilterExtensions(filter)
    assert.equal(ext.isRising, true)
    assert.equal(filter.search, 'cats')
  })

  it('should extract is:popular', () => {
    const filter = { search: 'is:popular dogs' }
    const ext = extractFilterExtensions(filter)
    assert.equal(ext.isPopular, true)
    assert.equal(filter.search, 'dogs')
  })

  it('should shadow includeSpam when explicit audience filter is set', () => {
    const filter = { search: 'include:spam is:rising' }
    const ext = extractFilterExtensions(filter)
    assert.equal(ext.includeSpam, false)
    assert.equal(ext.isRising, true)
  })

  it('should keep includeSpam when no explicit audience filter', () => {
    const filter = { search: 'include:spam test' }
    const ext = extractFilterExtensions(filter)
    assert.equal(ext.includeSpam, true)
  })

  it('should extract multiple languages and limit to 5', () => {
    const filter = { search: 'language:en language:pt language:es language:fr language:de language:it language:ja' }
    const ext = extractFilterExtensions(filter)
    assert.equal(ext.language.length, 5)
    assert.deepEqual(ext.language, ['en', 'pt', 'es', 'fr', 'de'])
  })

  it('should deduplicate languages', () => {
    const filter = { search: 'language:en language:en language:pt' }
    const ext = extractFilterExtensions(filter)
    assert.deepEqual(ext.language, ['en', 'pt'])
  })

  it('should extract sort:top', () => {
    const filter = { search: 'sort:top' }
    const ext = extractFilterExtensions(filter)
    assert.equal(ext.sortTop, true)
    assert.equal(filter.search, '')
  })

  it('should extract combined extensions', () => {
    const filter = { search: 'is:spam is:rising sort:top language:en test query' }
    const ext = extractFilterExtensions(filter)
    assert.equal(ext.isSpam, true)
    assert.equal(ext.isRising, true)
    assert.equal(ext.sortTop, true)
    assert.deepEqual(ext.language, ['en'])
    assert.equal(filter.search, 'test query')
  })

  it('should extract single topic', () => {
    const filter = { search: 'topic:pokemon test' }
    const ext = extractFilterExtensions(filter)
    assert.deepEqual(ext.topic, ['pokemon'])
    assert.equal(filter.search, 'test')
  })

  it('should extract multiple topics and deduplicate', () => {
    const filter = { search: 'topic:bitcoin topic:crypto topic:bitcoin' }
    const ext = extractFilterExtensions(filter)
    assert.deepEqual(ext.topic, ['bitcoin', 'crypto'])
    assert.equal(filter.search, '')
  })

  it('should limit topics to 10', () => {
    const topics = Array.from({ length: 12 }, (_, i) => `topic:tag${i}`).join(' ')
    const filter = { search: topics }
    const ext = extractFilterExtensions(filter)
    assert.equal(ext.topic.length, 10)
  })

  it('should lowercase topic values', () => {
    const filter = { search: 'topic:Pokemon' }
    const ext = extractFilterExtensions(filter)
    assert.deepEqual(ext.topic, ['pokemon'])
  })

  it('should support topic with dashes and underscores', () => {
    const filter = { search: 'topic:open-source topic:my_topic' }
    const ext = extractFilterExtensions(filter)
    assert.deepEqual(ext.topic, ['open-source', 'my_topic'])
  })
})

describe('buildPopularityFilter', () => {
  it('should return default filter for no flags', () => {
    const result = buildPopularityFilter({})
    assert.deepEqual(result, ['popularityLevel <= 6'])
  })

  it('should return null for includeSpam (no filter = all levels)', () => {
    const result = buildPopularityFilter({ includeSpam: true })
    assert.equal(result, null)
  })

  it('should filter for isPopular only', () => {
    const result = buildPopularityFilter({ isPopular: true })
    assert.deepEqual(result, ['popularityLevel <= 5'])
  })

  it('should filter for isRising only', () => {
    const result = buildPopularityFilter({ isRising: true })
    assert.deepEqual(result, ['popularityLevel = 6'])
  })

  it('should filter for isSpam only', () => {
    const result = buildPopularityFilter({ isSpam: true })
    assert.deepEqual(result, ['popularityLevel > 6'])
  })

  it('should OR-combine isSpam and isRising', () => {
    const result = buildPopularityFilter({ isSpam: true, isRising: true })
    assert.deepEqual(result, ['popularityLevel = 6', 'popularityLevel > 6'])
  })

  it('should OR-combine all three audience filters', () => {
    const result = buildPopularityFilter({ isPopular: true, isRising: true, isSpam: true })
    assert.deepEqual(result, ['popularityLevel <= 5', 'popularityLevel = 6', 'popularityLevel > 6'])
  })
})

describe('parseNip50PathExtensions', () => {
  it('should return null for non-nip50 path', () => {
    assert.equal(parseNip50PathExtensions('/'), null)
    assert.equal(parseNip50PathExtensions('/other'), null)
  })

  it('should return null for path with no segments', () => {
    assert.equal(parseNip50PathExtensions('/.well-known/nip50/'), null)
  })

  it('should return null for unknown extension', () => {
    assert.equal(parseNip50PathExtensions('/.well-known/nip50/unknown:ext'), null)
  })

  it('should parse sort:top', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/sort:top')
    assert.deepEqual(ext, { sortTop: true })
  })

  it('should parse is:spam', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/is:spam')
    assert.deepEqual(ext, { isSpam: true })
  })

  it('should parse is:rising', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/is:rising')
    assert.deepEqual(ext, { isRising: true })
  })

  it('should parse is:popular', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/is:popular')
    assert.deepEqual(ext, { isPopular: true })
  })

  it('should parse include:spam', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/include:spam')
    assert.deepEqual(ext, { includeSpam: true })
  })

  it('should parse language:xx', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/language:en')
    assert.deepEqual(ext, { language: ['en'] })
  })

  it('should parse combined extensions', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/sort:top/language:en')
    assert.deepEqual(ext, { sortTop: true, language: ['en'] })
  })

  it('should shadow includeSpam with explicit audience filter', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/include:spam/is:rising')
    assert.equal(ext.includeSpam, false)
    assert.equal(ext.isRising, true)
  })

  it('should limit languages to 5', () => {
    const ext = parseNip50PathExtensions(
      '/.well-known/nip50/language:en/language:pt/language:es/language:fr/language:de/language:it'
    )
    assert.equal(ext.language.length, 5)
  })

  it('should deduplicate languages', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/language:en/language:en')
    assert.deepEqual(ext.language, ['en'])
  })

  it('should parse topic:xxx', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/topic:pokemon')
    assert.deepEqual(ext, { topic: ['pokemon'] })
  })

  it('should parse multiple topics and deduplicate', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/topic:bitcoin/topic:crypto/topic:bitcoin')
    assert.deepEqual(ext.topic, ['bitcoin', 'crypto'])
  })

  it('should parse topic with combined extensions', () => {
    const ext = parseNip50PathExtensions('/.well-known/nip50/sort:top/topic:anime/language:en')
    assert.deepEqual(ext, { sortTop: true, topic: ['anime'], language: ['en'] })
  })

  it('should limit topics to 10 via path', () => {
    const segments = Array.from({ length: 12 }, (_, i) => `topic:tag${i}`).join('/')
    const ext = parseNip50PathExtensions(`/.well-known/nip50/${segments}`)
    assert.equal(ext.topic.length, 10)
  })
})

describe('applyPathExtensionsToFilter', () => {
  it('should do nothing when pathExtensions is null', () => {
    const filter = { kinds: [1] }
    applyPathExtensionsToFilter(filter, null)
    assert.deepEqual(filter, { kinds: [1] })
  })

  it('should apply boolean extensions if not already set', () => {
    const filter = {}
    applyPathExtensionsToFilter(filter, { sortTop: true, isSpam: true })
    assert.equal(filter.sortTop, true)
    assert.equal(filter.isSpam, true)
  })

  it('should not overwrite existing boolean extensions', () => {
    const filter = { isSpam: true }
    applyPathExtensionsToFilter(filter, { isRising: true })
    assert.equal(filter.isSpam, true)
    assert.equal(filter.isRising, true)
  })

  it('should merge languages', () => {
    const filter = { language: ['pt'] }
    applyPathExtensionsToFilter(filter, { language: ['en'] })
    assert.deepEqual(filter.language, ['pt', 'en'])
  })

  it('should set language when filter has none', () => {
    const filter = {}
    applyPathExtensionsToFilter(filter, { language: ['en'] })
    assert.deepEqual(filter.language, ['en'])
  })

  it('should dedupe merged languages and limit to 5', () => {
    const filter = { language: ['en', 'pt', 'es'] }
    applyPathExtensionsToFilter(filter, { language: ['en', 'fr', 'de', 'it'] })
    assert.equal(filter.language.length, 5)
    assert.ok(!filter.language.includes('it'))
  })

  it('should re-apply includeSpam shadowing after merge', () => {
    const filter = { includeSpam: true }
    applyPathExtensionsToFilter(filter, { isRising: true })
    assert.equal(filter.includeSpam, false)
    assert.equal(filter.isRising, true)
  })

  it('should merge topics', () => {
    const filter = { topic: ['bitcoin'] }
    applyPathExtensionsToFilter(filter, { topic: ['crypto'] })
    assert.deepEqual(filter.topic, ['bitcoin', 'crypto'])
  })

  it('should set topics when filter has none', () => {
    const filter = {}
    applyPathExtensionsToFilter(filter, { topic: ['pokemon'] })
    assert.deepEqual(filter.topic, ['pokemon'])
  })

  it('should dedupe merged topics and limit to 10', () => {
    const filter = { topic: ['a', 'b', 'c'] }
    const pathTopics = Array.from({ length: 10 }, (_, i) => `t${i}`)
    applyPathExtensionsToFilter(filter, { topic: pathTopics })
    assert.equal(filter.topic.length, 10)
    assert.ok(filter.topic.includes('a'))
  })
})
