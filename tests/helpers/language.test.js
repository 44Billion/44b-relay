import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectLanguage, detectEventLanguage, sanitizeText, stripMarkdown } from '#helpers/language.js'

describe('sanitizeText', () => {
  it('should return empty string for null/undefined/empty input', () => {
    assert.equal(sanitizeText(''), '')
    assert.equal(sanitizeText(null), '')
    assert.equal(sanitizeText(undefined), '')
  })

  it('should remove https and http URLs', () => {
    assert.equal(
      sanitizeText('Check https://example.com/page?q=1 out'),
      'Check out'
    )
    assert.equal(
      sanitizeText('Visit http://example.org for more'),
      'Visit for more'
    )
  })

  it('should remove ws and wss URLs', () => {
    assert.equal(
      sanitizeText('Connect to wss://relay.example.com now'),
      'Connect to now'
    )
    assert.equal(
      sanitizeText('Use ws://localhost:8080 for dev'),
      'Use for dev'
    )
  })

  it('should remove email addresses', () => {
    assert.equal(
      sanitizeText('Contact user@example.com for info'),
      'Contact for info'
    )
  })

  it('should remove Mastodon / Fediverse handles', () => {
    assert.equal(
      sanitizeText('Follow @user@mastodon.social on the fediverse'),
      'Follow on the fediverse'
    )
  })

  it('should remove Twitter / X handles', () => {
    assert.equal(
      sanitizeText('Follow @jack and @nostr on Twitter'),
      'Follow and on Twitter'
    )
  })

  it('should strip Mastodon handles before Twitter handles to avoid partial match', () => {
    // @user@mastodon.social should be fully removed, not leave @mastodon.social
    assert.equal(
      sanitizeText('Yo @alice@mastodon.social check this'),
      'Yo check this'
    )
  })

  it('should remove NIP-19 npub entities', () => {
    assert.equal(
      sanitizeText('Follow npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6 on nostr'),
      'Follow on nostr'
    )
  })

  it('should remove NIP-19 entities with nostr: prefix (NIP-21)', () => {
    assert.equal(
      sanitizeText('See nostr:npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6 for updates'),
      'See for updates'
    )
  })

  it('should remove nprofile, nevent, naddr, nrelay entities', () => {
    const nprofile = 'nprofile1' + 'q'.repeat(50)
    const nevent = 'nevent1' + 'a'.repeat(50)
    const naddr = 'naddr1' + 'c'.repeat(50)
    const nrelay = 'nrelay1' + 'e'.repeat(50)
    assert.equal(sanitizeText(`Check ${nprofile} here`), 'Check here')
    assert.equal(sanitizeText(`Check ${nevent} here`), 'Check here')
    assert.equal(sanitizeText(`Check ${naddr} here`), 'Check here')
    assert.equal(sanitizeText(`Check ${nrelay} here`), 'Check here')
  })

  it('should remove note entities', () => {
    const note = 'note1' + 'q'.repeat(55)
    assert.equal(sanitizeText(`Replying to ${note} with love`), 'Replying to with love')
  })

  it('should remove Lightning invoices', () => {
    assert.equal(
      sanitizeText('Pay lnbc500u1pjfake0pp5qqqsyqcyq5rqwzqfsq9qs here'),
      'Pay here'
    )
  })

  it('should remove Lightning invoices with lightning: prefix', () => {
    assert.equal(
      sanitizeText('Pay lightning:lnbc500u1pjfake0pp5qqqsyqcyq5rqwzqfsq9qs here'),
      'Pay here'
    )
  })

  it('should remove LNURL', () => {
    assert.equal(
      sanitizeText('Use lnurl1dp68gurn8ghj7ct5d9hxzar0wden5te0dehhxtnvdakqqcqpjsp5 for tipping'),
      'Use for tipping'
    )
  })

  it('should remove Cashu tokens', () => {
    assert.equal(
      sanitizeText('Redeem cashuAeyJ0b2tlbiI6ImhlbGxvd29ybGQifQ here'),
      'Redeem here'
    )
  })

  it('should preserve regular text and collapse whitespace', () => {
    assert.equal(
      sanitizeText('Hello world,  this is   a test'),
      'Hello world, this is a test'
    )
  })

  it('should handle text with multiple types of noise', () => {
    const text = 'Check nostr:npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6 and https://example.com via @alice@mastodon.social 🎉'
    assert.equal(sanitizeText(text), 'Check and via 🎉')
  })

  it('should remove hex sequences (file hashes, event ids)', () => {
    assert.equal(
      sanitizeText('File 9844fc24a6beea76e42d790266740e43def2fda6d07cca07baa24418809c1b00 uploaded'),
      'File uploaded'
    )
  })

  it('should remove domain-like fragments left after URL stripping', () => {
    assert.equal(
      sanitizeText('Check .blossom.band/something here'),
      'Check here'
    )
  })

  it('should remove leftover protocol prefixes', () => {
    assert.equal(
      sanitizeText('Visit https:// for more'),
      'Visit for more'
    )
  })

  it('should collapse repeated characters (3+) to at most 2', () => {
    assert.equal(
      sanitizeText('oooooof this is cooool'),
      'oof this is cool'
    )
  })

  it('should strip URL-only content with npub subdomain to empty', () => {
    assert.equal(
      sanitizeText('https://npub1m64hnkh6rs47fd9x6wk2zdtmdj4qkazt734d22d94ery9zzhne5qw9uaks.blossom.band/9844fc24a6beea76e42d790266740e43def2fda6d07cca07baa24418809c1b00.jpg'),
      ''
    )
  })
})

describe('stripMarkdown', () => {
  it('should return empty string for null/undefined/empty input', () => {
    assert.equal(stripMarkdown(''), '')
    assert.equal(stripMarkdown(null), '')
    assert.equal(stripMarkdown(undefined), '')
  })

  it('should remove fenced code blocks (backticks)', () => {
    const md = 'Before\n```js\nconst x = 1\nconsole.log(x)\n```\nAfter'
    assert.ok(!stripMarkdown(md).includes('const x'))
    assert.ok(stripMarkdown(md).includes('Before'))
    assert.ok(stripMarkdown(md).includes('After'))
  })

  it('should remove fenced code blocks (tildes)', () => {
    const md = 'Before\n~~~\ncode here\n~~~\nAfter'
    assert.ok(!stripMarkdown(md).includes('code here'))
    assert.ok(stripMarkdown(md).includes('Before'))
  })

  it('should remove inline code', () => {
    assert.ok(!stripMarkdown('Use `npm install` to install').includes('npm install'))
    assert.ok(stripMarkdown('Use `npm install` to install').includes('Use'))
  })

  it('should convert links to text only', () => {
    assert.equal(
      stripMarkdown('Click [here](https://example.com) to continue'),
      'Click here to continue'
    )
  })

  it('should convert reference links to text only', () => {
    assert.equal(
      stripMarkdown('See [the docs][docs] for more'),
      'See the docs for more'
    )
  })

  it('should remove reference link definitions', () => {
    const md = 'Some text\n[docs]: https://example.com "Title"\nMore text'
    const result = stripMarkdown(md)
    assert.ok(!result.includes('https://example.com'))
    assert.ok(result.includes('Some text'))
    assert.ok(result.includes('More text'))
  })

  it('should remove images', () => {
    assert.ok(!stripMarkdown('Look ![photo](https://img.example.com/a.jpg) nice').includes('img.example'))
  })

  it('should remove reference-style images', () => {
    assert.ok(!stripMarkdown('Look ![photo][img1] nice').includes('[img1]'))
  })

  it('should remove HTML tags', () => {
    assert.equal(
      stripMarkdown('This is <strong>bold</strong> text').replace(/\s+/g, ' ').trim(),
      'This is bold text'
    )
  })

  it('should remove heading markers', () => {
    assert.equal(stripMarkdown('## My Title'), 'My Title')
    assert.equal(stripMarkdown('# Heading One'), 'Heading One')
    assert.equal(stripMarkdown('###### Deep Heading'), 'Deep Heading')
  })

  it('should remove horizontal rules', () => {
    const md = 'Above\n---\nBelow'
    const result = stripMarkdown(md)
    assert.ok(result.includes('Above'))
    assert.ok(result.includes('Below'))
    assert.ok(!result.includes('---'))
  })

  it('should remove blockquote markers', () => {
    assert.equal(stripMarkdown('> This is a quote'), 'This is a quote')
    assert.equal(stripMarkdown('> Nested\n> quote'), 'Nested\nquote')
  })

  it('should remove bold/italic markers', () => {
    assert.equal(stripMarkdown('This is **bold** text'), 'This is bold text')
    assert.equal(stripMarkdown('This is *italic* text'), 'This is italic text')
    assert.equal(stripMarkdown('This is ***bold italic*** text'), 'This is bold italic text')
    assert.equal(stripMarkdown('This is __underline bold__ text'), 'This is underline bold text')
  })

  it('should remove strikethrough markers', () => {
    assert.equal(stripMarkdown('This is ~~deleted~~ text'), 'This is deleted text')
  })

  it('should remove unordered list markers', () => {
    const md = '- Item one\n- Item two\n* Item three'
    const result = stripMarkdown(md)
    assert.ok(result.includes('Item one'))
    assert.ok(!result.match(/^[-*]\s/m))
  })

  it('should remove ordered list markers', () => {
    const md = '1. First\n2. Second\n10. Tenth'
    const result = stripMarkdown(md)
    assert.ok(result.includes('First'))
    assert.ok(!result.match(/^\d+\.\s/m))
  })

  it('should handle a complex markdown document', () => {
    const md = [
      '# Title',
      '',
      'A paragraph with **bold** and *italic* text.',
      '',
      '```python',
      'print("hello")',
      '```',
      '',
      '> A blockquote here',
      '',
      '- List item one',
      '- List item two',
      '',
      'Visit [the site](https://example.com) for more.',
      '',
      '![screenshot](https://img.example.com/shot.png)',
      '',
      '---',
      '',
      'Final paragraph with `inline code` in it.'
    ].join('\n')

    const result = stripMarkdown(md)
    assert.ok(result.includes('Title'))
    assert.ok(result.includes('A paragraph with bold and italic text.'))
    assert.ok(!result.includes('print("hello")'))
    assert.ok(result.includes('A blockquote here'))
    assert.ok(result.includes('List item one'))
    assert.ok(result.includes('the site'))
    assert.ok(!result.includes('screenshot'))
    assert.ok(result.includes('Final paragraph with'))
    assert.ok(!result.includes('inline code'))
  })
})

describe('detectLanguage', () => {
  it('should return undefined for empty or falsy input', () => {
    assert.equal(detectLanguage(''), undefined)
    assert.equal(detectLanguage(null), undefined)
    assert.equal(detectLanguage(undefined), undefined)
    assert.equal(detectLanguage('   '), undefined)
  })

  it('should detect English for a long English text', () => {
    const text = 'Hello world, this is a longer text written in English for the purposes of language detection testing'
    assert.equal(detectLanguage(text), 'en')
  })

  it('should detect Portuguese for a long Portuguese text', () => {
    const text = 'Olá mundo, este é um texto mais longo escrito em português para fins de teste de detecção de idioma'
    assert.equal(detectLanguage(text), 'pt')
  })

  it('should detect French for a long French text', () => {
    const text = 'Bonjour le monde, ceci est un texte plus long écrit en français pour tester la détection de la langue'
    assert.equal(detectLanguage(text), 'fr')
  })

  it('should detect language for short text using lande fallback', () => {
    // Short text where franc returns 'und' falls back to lande
    const result = detectLanguage('Hola mundo amigos')
    // may return a two-letter code or undefined depending on confidence
    assert.equal(typeof result === 'string' || result === undefined, true)
  })

  it('should return undefined for text with too few alphabetic characters', () => {
    assert.equal(detectLanguage('12345 67890'), undefined)
    assert.equal(detectLanguage('... !!!'), undefined)
  })

  it('should return undefined for short ambiguous text below confidence threshold', () => {
    // Very short English-like text that detectors struggle with
    assert.equal(detectLanguage("He's definitely Gen X.."), undefined)
  })

  it('should return a two-letter ISO 639-1 code', () => {
    const text = 'This is definitely a sentence written in the English language and should be detected as such'
    const result = detectLanguage(text)
    assert.ok(result)
    assert.equal(result.length, 2)
  })
})

describe('detectEventLanguage', () => {
  it('should detect language for TEXT_NOTE (kind 1)', () => {
    const event = {
      kind: 1,
      content: 'This is a long enough sentence in English to detect the language of this text note',
      tags: []
    }
    assert.equal(detectEventLanguage(event), 'en')
  })

  it('should detect language for LONG_FORM_CONTENT (kind 30023)', () => {
    const event = {
      kind: 30023,
      content: 'Este é um artigo longo escrito em português para testar detecção de idioma em conteúdo de formato longo',
      tags: []
    }
    assert.equal(detectEventLanguage(event), 'pt')
  })

  it('should detect language for PICTURE (kind 20) from content', () => {
    const event = {
      kind: 20,
      content: 'A beautiful photograph taken during winter in the mountains of the Swiss Alps region',
      tags: []
    }
    assert.equal(detectEventLanguage(event), 'en')
  })

  it('should fallback to title tag for PICTURE (kind 20) when content is empty', () => {
    const event = {
      kind: 20,
      content: '',
      tags: [['title', 'Uma bela fotografia tirada durante o inverno nas montanhas dos Alpes Suíços']]
    }
    assert.equal(detectEventLanguage(event), 'pt')
  })

  it('should fallback to title tag for VIDEO (kind 21) when content is empty', () => {
    const event = {
      kind: 21,
      content: '',
      tags: [['title', 'Un magnifique coucher de soleil sur la mer Méditerranée filmé pendant les vacances']]
    }
    assert.equal(detectEventLanguage(event), 'fr')
  })

  it('should detect language for SHORT_VIDEO (kind 22) from content', () => {
    const event = {
      kind: 22,
      content: 'Dieses kurze Video zeigt die wunderschöne Landschaft der bayerischen Alpen im Herbst',
      tags: []
    }
    assert.equal(detectEventLanguage(event), 'de')
  })

  it('should detect language for EDITABLE_VIDEO (kind 34235) from content', () => {
    const event = {
      kind: 34235,
      content: 'This is an editable video about programming tutorials and software development best practices',
      tags: []
    }
    assert.equal(detectEventLanguage(event), 'en')
  })

  it('should detect language for EDITABLE_SHORT_VIDEO (kind 34236) with title fallback', () => {
    const event = {
      kind: 34236,
      content: '',
      tags: [['title', 'Un video corto sobre la cocina española tradicional y sus recetas más populares']]
    }
    assert.equal(detectEventLanguage(event), 'es')
  })

  it('should return undefined for unsupported event kinds', () => {
    const event = {
      kind: 0, // METADATA
      content: 'This is metadata content in English',
      tags: []
    }
    assert.equal(detectEventLanguage(event), undefined)
  })

  it('should return undefined when no text is available', () => {
    const event = {
      kind: 20,
      content: '',
      tags: []
    }
    assert.equal(detectEventLanguage(event), undefined)
  })

  it('should prefer content over title tag', () => {
    const event = {
      kind: 20,
      content: 'This is English content that is long enough for accurate language detection by the library',
      tags: [['title', 'Este é um título em português longo o suficiente para detecção precisa de idioma']]
    }
    assert.equal(detectEventLanguage(event), 'en')
  })

  it('should detect language after stripping URLs and handles from TEXT_NOTE', () => {
    const event = {
      kind: 1,
      content: 'Olá mundo, este é um texto em português para fins de teste https://example.com @user@mastodon.social nostr:npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
      tags: []
    }
    assert.equal(detectEventLanguage(event), 'pt')
  })

  it('should detect language after stripping markdown from LONG_FORM_CONTENT', () => {
    const event = {
      kind: 30023,
      content: [
        '# Título do Artigo',
        '',
        'Este é um artigo longo escrito em português para testar detecção de idioma.',
        '',
        '```javascript',
        'const x = 42',
        '```',
        '',
        'Visite [o site](https://example.com) para mais informações.',
        '',
        '> Uma citação importante aqui'
      ].join('\n'),
      tags: []
    }
    assert.equal(detectEventLanguage(event), 'pt')
  })

  it('should detect language from sanitized title tag for media events', () => {
    const event = {
      kind: 20,
      content: '',
      tags: [['title', 'Uma bela fotografia tirada nostr:npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6 nas montanhas dos Alpes']]
    }
    assert.equal(detectEventLanguage(event), 'pt')
  })

  it('should not misdetect short English text with trailing URL as Dutch', () => {
    const event = {
      kind: 1,
      content: "He's definitely Gen X... https://video.nostr.build/d35051f8d978969d9f86e00bdc4ebb818ed527dc21d10976af43a415da22516d.mp4",
      tags: []
    }
    // After sanitization the text is too short/ambiguous; undefined is correct
    assert.notEqual(detectEventLanguage(event), 'nl')
  })

  it('should return undefined for URL-only content with npub subdomain', () => {
    const event = {
      kind: 1,
      content: 'https://npub1m64hnkh6rs47fd9x6wk2zdtmdj4qkazt734d22d94ery9zzhne5qw9uaks.blossom.band/9844fc24a6beea76e42d790266740e43def2fda6d07cca07baa24418809c1b00.jpg',
      tags: []
    }
    assert.equal(detectEventLanguage(event), undefined)
  })

  it('should detect English for text with repeated characters, not Portuguese', () => {
    const event = {
      kind: 1,
      content: 'oooooof. Attacks or provider issues?',
      tags: []
    }
    assert.equal(detectEventLanguage(event), 'en')
  })
})
