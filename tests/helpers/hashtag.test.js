import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractHashtags,
  normalizeTag,
  splitTagIntoWords,
  deriveAcronym,
  areMorphologicalSynonyms
} from '#helpers/hashtag.js'

describe('normalizeTag', () => {
  it('should lowercase and trim', () => {
    assert.equal(normalizeTag('  Pokemon  '), 'pokemon')
  })

  it('should strip leading #', () => {
    assert.equal(normalizeTag('#Bitcoin'), 'bitcoin')
  })

  it('should collapse internal spaces', () => {
    assert.equal(normalizeTag('Open Source'), 'opensource')
  })

  it('should return null for empty/falsy input', () => {
    assert.equal(normalizeTag(''), null)
    assert.equal(normalizeTag(null), null)
    assert.equal(normalizeTag(undefined), null)
  })

  it('should return null for tags shorter than 2 chars', () => {
    assert.equal(normalizeTag('a'), null)
  })

  it('should return null for tags longer than 80 chars', () => {
    assert.equal(normalizeTag('a'.repeat(81)), null)
  })

  it('should return null for all-digit tags', () => {
    assert.equal(normalizeTag('12345'), null)
  })

  it('should return null for tags with 5+ repeated chars', () => {
    assert.equal(normalizeTag('aaaaaa'), null)
  })

  it('should allow tags with 4 repeated chars', () => {
    assert.equal(normalizeTag('aaaa'), 'aaaa')
  })

  it('should handle non-string input gracefully', () => {
    assert.equal(normalizeTag(42), null)
    assert.equal(normalizeTag({}), null)
  })
})

describe('splitTagIntoWords', () => {
  it('should split camelCase', () => {
    assert.deepEqual(splitTagIntoWords('helloWorld'), ['hello', 'world'])
  })

  it('should split PascalCase', () => {
    assert.deepEqual(splitTagIntoWords('AHashtagExample'), ['a', 'hashtag', 'example'])
  })

  it('should split dashes', () => {
    assert.deepEqual(splitTagIntoWords('a-hashtag-example'), ['a', 'hashtag', 'example'])
  })

  it('should split underscores', () => {
    assert.deepEqual(splitTagIntoWords('a_hashtag_example'), ['a', 'hashtag', 'example'])
  })

  it('should split spaces (typed form)', () => {
    assert.deepEqual(splitTagIntoWords('Other hashtag example'), ['other', 'hashtag', 'example'])
  })

  it('should handle HTMLParser-style acronyms', () => {
    assert.deepEqual(splitTagIntoWords('HTMLParser'), ['html', 'parser'])
  })

  it('should return single word for no-boundary input', () => {
    assert.deepEqual(splitTagIntoWords('pokemon'), ['pokemon'])
  })

  it('should return empty array for falsy input', () => {
    assert.deepEqual(splitTagIntoWords(''), [])
    assert.deepEqual(splitTagIntoWords(null), [])
    assert.deepEqual(splitTagIntoWords(undefined), [])
  })

  it('should handle mixed camelCase and dashes', () => {
    assert.deepEqual(splitTagIntoWords('my-CamelCase'), ['my', 'camel', 'case'])
  })
})

describe('deriveAcronym', () => {
  it('should derive acronym from multiple words', () => {
    assert.equal(deriveAcronym(['a', 'hashtag', 'example']), 'ahe')
  })

  it('should return null for single word', () => {
    assert.equal(deriveAcronym(['pokemon']), null)
  })

  it('should return null for empty or null array', () => {
    assert.equal(deriveAcronym([]), null)
    assert.equal(deriveAcronym(null), null)
  })

  it('should return null for acronym longer than 6 chars', () => {
    assert.equal(deriveAcronym(['a', 'b', 'c', 'd', 'e', 'f', 'g']), null)
  })

  it('should return acronym of exactly 6 chars', () => {
    assert.equal(deriveAcronym(['a', 'b', 'c', 'd', 'e', 'f']), 'abcdef')
  })

  it('should derive 2-char acronym from 2 words', () => {
    assert.equal(deriveAcronym(['open', 'source']), 'os')
  })
})

describe('areMorphologicalSynonyms', () => {
  describe('English (Snowball stemmer)', () => {
    it('should detect s/plural: sport/sports', () => {
      assert.equal(areMorphologicalSynonyms('sport', 'sports', 'en'), true)
    })

    it('should detect es/plural: watch/watches', () => {
      assert.equal(areMorphologicalSynonyms('watch', 'watches', 'en'), true)
    })

    it('should detect y/ies: variety/varieties', () => {
      assert.equal(areMorphologicalSynonyms('variety', 'varieties', 'en'), true)
    })

    it('should detect ing suffix: develop/developing', () => {
      assert.equal(areMorphologicalSynonyms('develop', 'developing', 'en'), true)
    })

    it('should detect e/ing: make/making', () => {
      assert.equal(areMorphologicalSynonyms('make', 'making', 'en'), true)
    })

    it('should detect ed suffix: develop/developed', () => {
      assert.equal(areMorphologicalSynonyms('develop', 'developed', 'en'), true)
    })

    it('should return false for identical tags', () => {
      assert.equal(areMorphologicalSynonyms('sport', 'sport', 'en'), false)
    })

    it('should return false for unrelated tags', () => {
      assert.equal(areMorphologicalSynonyms('sport', 'pokemon', 'en'), false)
    })

    it('should handle order independently (b, a) same as (a, b)', () => {
      assert.equal(areMorphologicalSynonyms('sports', 'sport', 'en'), true)
    })

    it('should detect er suffix: develop/developer', () => {
      assert.equal(areMorphologicalSynonyms('develop', 'developer', 'en'), true)
    })

    it('should detect ly suffix: quick/quickly', () => {
      assert.equal(areMorphologicalSynonyms('quick', 'quickly', 'en'), true)
    })
  })

  describe('Portuguese (Snowball stemmer)', () => {
    it('should detect pt plural: esporte/esportes', () => {
      assert.equal(areMorphologicalSynonyms('esporte', 'esportes', 'pt'), true)
    })

    it('should detect pt gerund: desenvolver/desenvolvendo', () => {
      assert.equal(areMorphologicalSynonyms('desenvolver', 'desenvolvendo', 'pt'), true)
    })

    it('should return false for unrelated pt tags', () => {
      assert.equal(areMorphologicalSynonyms('esporte', 'musica', 'pt'), false)
    })
  })

  describe('Spanish (Snowball stemmer)', () => {
    it('should detect es plural: deporte/deportes', () => {
      assert.equal(areMorphologicalSynonyms('deporte', 'deportes', 'es'), true)
    })
  })

  describe('Fallback (unsupported language)', () => {
    it('should use prefix heuristic when language is not supported', () => {
      // "sport" and "sports" share 100% prefix + suffix diff is 1 char → true
      assert.equal(areMorphologicalSynonyms('sport', 'sports', 'xx'), true)
    })

    it('should use prefix heuristic when language is undefined', () => {
      assert.equal(areMorphologicalSynonyms('sport', 'sports'), true)
    })

    it('should return false for unrelated tags in fallback', () => {
      assert.equal(areMorphologicalSynonyms('abc', 'xyz'), false)
    })

    it('should return false when suffix diff is too large in fallback', () => {
      assert.equal(areMorphologicalSynonyms('cat', 'category'), false)
    })
  })
})

describe('extractHashtags', () => {
  it('should extract and normalize t tags from an event', () => {
    const event = {
      tags: [
        ['t', 'Pokemon', 'Pokemon'],
        ['t', 'anime']
      ]
    }
    const result = extractHashtags(event)
    assert.equal(result.length, 2)
    assert.equal(result[0].tag, 'pokemon')
    assert.equal(result[1].tag, 'anime')
  })

  it('should deduplicate normalized tags', () => {
    const event = {
      tags: [
        ['t', 'Pokemon'],
        ['t', 'pokemon'],
        ['t', 'POKEMON']
      ]
    }
    const result = extractHashtags(event)
    assert.equal(result.length, 1)
    assert.equal(result[0].tag, 'pokemon')
  })

  it('should use typed (third element) for word splitting when available', () => {
    const event = {
      tags: [
        ['t', 'ahashtagexample', 'AHashtagExample']
      ]
    }
    const result = extractHashtags(event)
    assert.equal(result.length, 1)
    assert.equal(result[0].tag, 'ahashtagexample')
    assert.deepEqual(result[0].words, ['a', 'hashtag', 'example'])
    assert.equal(result[0].acronym, 'ahe')
  })

  it('should split tag from first value when no typed form', () => {
    const event = {
      tags: [
        ['t', 'open-source']
      ]
    }
    const result = extractHashtags(event)
    assert.equal(result[0].tag, 'open-source')
    assert.deepEqual(result[0].words, ['open', 'source'])
    assert.equal(result[0].acronym, 'os')
  })

  it('should return empty array for event with no tags', () => {
    assert.deepEqual(extractHashtags({ tags: [] }), [])
    assert.deepEqual(extractHashtags({}), [])
    assert.deepEqual(extractHashtags(null), [])
  })

  it('should skip non-t tags', () => {
    const event = {
      tags: [
        ['e', 'abc123'],
        ['p', 'def456'],
        ['t', 'bitcoin']
      ]
    }
    const result = extractHashtags(event)
    assert.equal(result.length, 1)
    assert.equal(result[0].tag, 'bitcoin')
  })

  it('should skip t tags with empty or missing value', () => {
    const event = {
      tags: [
        ['t', ''],
        ['t'],
        ['t', 'valid']
      ]
    }
    const result = extractHashtags(event)
    assert.equal(result.length, 1)
    assert.equal(result[0].tag, 'valid')
  })

  it('should handle typed form with spaces for word splitting', () => {
    const event = {
      tags: [
        ['t', 'otherhashtagexample', 'Other hashtag example']
      ]
    }
    const result = extractHashtags(event)
    assert.deepEqual(result[0].words, ['other', 'hashtag', 'example'])
    assert.equal(result[0].acronym, 'ohe')
  })

  it('should set typed to null when third element is not a string', () => {
    const event = {
      tags: [
        ['t', 'test', 42]
      ]
    }
    const result = extractHashtags(event)
    assert.equal(result[0].typed, null)
  })
})
