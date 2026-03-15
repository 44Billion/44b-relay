import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LanguageModel, split, candidates, rejoin, SUPPORTED_LANGUAGES } from '../../lib/wordninja/index.js'

describe('wordninja – English (default model)', () => {
  it('splits joined words', () => {
    assert.deepEqual(split('derekanderson'), ['derek', 'anderson'])
  })

  it('preserves existing spaces', () => {
    assert.deepEqual(split('derek anderson'), ['derek', ' ', 'anderson'])
  })

  it('preserves hyphens, underscores, slashes', () => {
    assert.deepEqual(split('derek-anderson'), ['derek', '-', 'anderson'])
    assert.deepEqual(split('derek_anderson'), ['derek', '_', 'anderson'])
    assert.deepEqual(split('derek/anderson'), ['derek', '/', 'anderson'])
  })

  it('handles uppercase input (preserves case)', () => {
    assert.deepEqual(split('DEREKANDERSON'), ['DEREK', 'ANDERSON'])
  })

  it('handles mixed digits and words', () => {
    assert.deepEqual(split('win32intel'), ['win', '32', 'intel'])
  })

  it("handles possessive 's", () => {
    assert.deepEqual(split("that'sthesheriff'sbadge"), ["that's", 'the', "sheriff's", 'badge'])
  })

  it('returns multiple candidate splits', () => {
    const result = candidates('derekanderson', 3)
    assert.deepEqual(result, [
      ['derek', 'anderson'],
      ['derek', 'anders', 'on'],
      ['derek', 'and', 'ers', 'on']
    ])
  })

  it('rejoins with correct spacing', () => {
    assert.equal(
      rejoin("that'sthesheriff's\"badge\" youarewearing!"),
      "that's the sheriff's \"badge\" you are wearing!"
    )
  })
})

describe('wordninja – LanguageModel options', () => {
  it('adds new words to the dictionary', () => {
    const lm = new LanguageModel({ language: 'en', addWords: ['Palaeoloxodon'] })
    assert.equal(
      lm.rejoin('Palaeoloxodonisanextinctgenusofelephant.'),
      'Palaeoloxodon is an extinct genus of elephant.'
    )
  })

  it('moves existing word to top with overwrite + addToTop', () => {
    const lm = new LanguageModel({ language: 'en', addWords: ['inc'], addToTop: true, overwrite: true })
    assert.equal(lm.rejoin('coinc'), 'co inc')
  })

  it('removes blacklisted words from the dictionary', () => {
    const lm = new LanguageModel({ language: 'en', blacklist: ['anderson'] })
    // Without 'anderson', the algorithm should split differently
    const result = lm.split('derekanderson')
    assert.ok(!result.includes('anderson'), 'blacklisted word should not appear')
  })

  it('throws for unsupported language', () => {
    assert.throws(() => new LanguageModel({ language: 'xx' }), /not supported/)
  })

  it('throws for custom language without wordFile', () => {
    assert.throws(() => new LanguageModel({ language: 'custom' }), /wordFile/)
  })

  it('exposes SUPPORTED_LANGUAGES', () => {
    assert.ok(Array.isArray(SUPPORTED_LANGUAGES))
    assert.ok(SUPPORTED_LANGUAGES.includes('en'))
    assert.ok(SUPPORTED_LANGUAGES.includes('de'))
  })
})

describe('wordninja – German (de)', () => {
  const lm = new LanguageModel({ language: 'de' })

  it('splits common German phrase', () => {
    assert.deepEqual(lm.split('wiegehtesdir'), ['wie', 'geht', 'es', 'dir'])
  })

  it('splits declaration of love', () => {
    assert.deepEqual(lm.split('ichliebedich'), ['ich', 'liebe', 'dich'])
  })

  it('splits with mixed case', () => {
    assert.deepEqual(lm.split('ICHLIEBEDICH'), ['ICH', 'LIEBE', 'DICH'])
  })
})

describe('wordninja – French (fr)', () => {
  const lm = new LanguageModel({ language: 'fr' })

  it('splits a common greeting phrase', () => {
    assert.deepEqual(lm.split('bonjourmonde'), ['bonjour', 'monde'])
  })

  it('splits a question', () => {
    assert.deepEqual(lm.split('commentvousappelezvous'), ['comment', 'vous', 'appelez', 'vous'])
  })

  it('keeps a single known word intact', () => {
    assert.deepEqual(lm.split('mademoiselle'), ['mademoiselle'])
  })
})

describe('wordninja – Spanish (es)', () => {
  const lm = new LanguageModel({ language: 'es' })

  it('splits a common greeting', () => {
    assert.deepEqual(lm.split('comoestas'), ['como', 'estas'])
  })

  it('splits a simple phrase', () => {
    assert.deepEqual(lm.split('buenosdias'), ['buenos', 'dias'])
  })
})

describe('wordninja – Italian (it)', () => {
  const lm = new LanguageModel({ language: 'it' })

  it('splits a greeting question', () => {
    assert.deepEqual(lm.split('comestai'), ['come', 'stai'])
  })

  it('keeps a single known word intact', () => {
    assert.deepEqual(lm.split('buongiorno'), ['buongiorno'])
  })

  it('splits a simple phrase', () => {
    assert.deepEqual(lm.split('ciaomondo'), ['ciao', 'mondo'])
  })
})

describe('wordninja – Portuguese (pt)', () => {
  const lm = new LanguageModel({ language: 'pt' })

  it('splits a morning greeting', () => {
    assert.deepEqual(lm.split('bomdia'), ['bom', 'dia'])
  })

  it('splits an evening greeting', () => {
    assert.deepEqual(lm.split('boanoite'), ['boa', 'noite'])
  })

  it('splits a multi-word phrase', () => {
    assert.deepEqual(lm.split('comovaibem'), ['como', 'vai', 'bem'])
  })
})

describe('wordninja – Dutch (nl)', () => {
  const lm = new LanguageModel({ language: 'nl' })

  it('splits a morning greeting', () => {
    assert.deepEqual(lm.split('goedmorgen'), ['goed', 'morgen'])
  })

  it('splits a casual greeting', () => {
    assert.deepEqual(lm.split('hoegaathet'), ['hoe', 'gaat', 'het'])
  })

  it('splits a multi-word phrase', () => {
    assert.deepEqual(lm.split('ikhouvanmuziek'), ['ik', 'hou', 'van', 'muziek'])
  })
})

describe('wordninja – Swedish (sv)', () => {
  const lm = new LanguageModel({ language: 'sv' })

  it('splits a simple phrase', () => {
    assert.deepEqual(lm.split('jagalskardej'), ['jag', 'alskar', 'dej'])
  })

  it('splits a question', () => {
    assert.deepEqual(lm.split('vadheterdu'), ['vad', 'heter', 'du'])
  })
})

describe('wordninja – Polish (pl)', () => {
  const lm = new LanguageModel({ language: 'pl' })

  it('splits a morning greeting', () => {
    assert.deepEqual(lm.split('dziendobry'), ['dzien', 'dobry'])
  })

  it('keeps a single known word intact', () => {
    assert.deepEqual(lm.split('nieznany'), ['nieznany'])
  })
})

describe('wordninja – Russian (ru)', () => {
  const lm = new LanguageModel({ language: 'ru' })

  it('splits a simple Cyrillic phrase', () => {
    assert.deepEqual(lm.split('приветмир'), ['привет', 'мир'])
  })

  it('splits a morning greeting', () => {
    assert.deepEqual(lm.split('доброеутро'), ['доброе', 'утро'])
  })

  it('splits a conversational phrase', () => {
    assert.deepEqual(lm.split('какдела'), ['как', 'дела'])
  })
})

describe('wordninja – Turkish (tr)', () => {
  const lm = new LanguageModel({ language: 'tr' })

  it('keeps a single known word intact', () => {
    assert.deepEqual(lm.split('merhaba'), ['merhaba'])
  })

  it('splits a location question', () => {
    assert.deepEqual(lm.split('neredegidiyorsun'), ['nerede', 'gidiyorsun'])
  })
})
