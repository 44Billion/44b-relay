import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { truncateWsMessage } from '#services/servers/web-socket-server.js'

describe('truncateWsMessage', () => {
  it('should truncate EVENT content to 70 chars and add total length', () => {
    const longContent = 'a'.repeat(100)
    const message = JSON.stringify(['EVENT', { content: longContent, sig: 'abcdef', tags: [] }])
    const result = JSON.parse(truncateWsMessage(message))

    assert.equal(result[1].content, 'a'.repeat(70) + '...(100)')
  })

  it('should truncate EVENT sig to 3 chars and add total length', () => {
    const message = JSON.stringify(['EVENT', { content: 'hello', sig: 'abcdef', tags: [] }])
    const result = JSON.parse(truncateWsMessage(message))

    assert.equal(result[1].sig, 'abc...(6)')
  })

  it('should truncate EVENT tags to 5 and indicate total more tags', () => {
    const tags = Array.from({ length: 10 }, (_, i) => [`tag${i}`, 'value'])
    const message = JSON.stringify(['EVENT', { content: 'hello', sig: 'abc', tags }])
    const result = JSON.parse(truncateWsMessage(message))

    assert.equal(result[1].tags.length, 6) // 5 tags + placeholder
    assert.equal(result[1].tags[5], '... and 5 more tags')
  })

  it('should truncate each tag value to 64 chars and add total length', () => {
    const longValue = 'b'.repeat(100)
    const message = JSON.stringify(['EVENT', { content: 'hello', sig: 'abc', tags: [['t', longValue]] }])
    const result = JSON.parse(truncateWsMessage(message))

    assert.equal(result[1].tags[0][1], 'b'.repeat(64) + '...(100)')
  })

  it('should handle non-EVENT messages by falling back to length-based truncation', () => {
    const longString = 'x'.repeat(200)
    const result = truncateWsMessage(longString)
    assert.equal(result, 'x'.repeat(140) + '...(200)')
  })

  it('should not truncate short strings', () => {
    const shortString = 'hello'
    const result = truncateWsMessage(shortString)
    assert.equal(result, 'hello')
  })

  it('should handle the specific example provided by the user', () => {
    const example = ['EVENT', {
      kind: 35128,
      tags: [
        ['d', 'fevela'],
        ['path', '.well-known/nostr.json', 'a214666e4470cebc7cd492b774c4fce7b63dd444a8e4457a8616caae7d567cbf'],
        ['path', 'apple-touch-icon.png', '9dbe0b817f41f48bf83e24786f13bf55218da1d8c4c46eec3000259154e6b440'],
        ['path', 'assets/cashu-DcJEXiZV.js', 'e5312959d6b9f7233448e5047e6abf03bc6157c7ac208bcd26bf23ccbdda6af0'],
        ['path', 'assets/cashu-ts.es-D2XvewYJ.js', '1a4e660c7b80a97f8aa300cdc724f8d66a190e249651a1cfe0693e223adb017a'],
        ['path', 'assets/index-DC4ACunm.js', 'ac105fd54f80aaaad7f9aa5fbf8d8f0346f37ba7302e3f745f841e7e770c5872'],
        ['path', 'assets/index-DN-BBK8a.css', '9661433fad03305a5cb8d0dadd5b4042d7f2fcd2ff6e5ffd307e3d315c5afe5a'],
        ['path', 'assets/index-lQoBlmMz.js', '5e9bb496395550878b066d30fd35f4eaba68353bf3fbe6d2af1694f08cff692e'],
        ['path', 'assets/qr-scanner-worker.min-D85Z9gVD.js', 'ea06eb510e12253bf39421979c7469c4065301acadb1d0cf25d07f1b54ed8872'],
        ['path', 'favicon.ico', '86bc8555b86c5c6592b508e5676320ded0f5355aedafa5a2cb955b9e8d4273a5'],
        ['path', 'favicon.svg', 'cf432e8c1a31a2a1beead5347362d4bdd47f167c42b1616bb055854f312e0376'],
        ['path', 'index.html', 'ba6225eabb7c46f2bc9a3e5001ca67117dccb88213a90f8f964a960ccec30bbf'],
        ['path', 'manifest.webmanifest', '305899fff561cb7c8e6edf21c517f204bb8873e6fb07f5fdf3ee429bd09efc34'],
        ['path', 'pwa-192x192.png', 'deef1441dc4a5aa5550a8608ec546c082deb3a69a9e51b4c590c805979468884'],
        ['path', 'pwa-512x512.png', 'e2dfdb4ea91a7c4c2a8fa9fbaaae87bd4a6a54874239af26a6e4f6f99557390a'],
        ['path', 'pwa-monochrome.svg', 'cf432e8c1a31a2a1beead5347362d4bdd47f167c42b1616bb055854f312e0376'],
        ['path', 'registerSW.js', '7579ac7e628a8a7ef1462c352eb07c8480b72d519c0f655a7d47cb4b33487bd7'],
        ['path', 'robots.txt', '741c0174b31c9a241a1e5568edb83c617cf16c5dcc7104c08ea22ad9482d0bc6'],
        ['path', 'sw.js', '395da590ba1cff226ed0478a40812cd75c7e5d41a825c7a4bbd689d7a5471871'],
        ['path', 'workbox-8c29f6e4.js', 'b76978646ab26fb8924d78193ff244c0fbdac626a65587a56761131ca00b8c3b']
      ],
      content: '',
      created_at: 1770048026,
      pubkey: '5a8bc85694d8fbb4f30208649c1c52509636d1e6fdb1f0f4c84a3f10f9383ec9',
      id: '870e0a43c955bf70728b59963c5972732955b779a29f6a231b551f9668d89fb6',
      sig: '34c8588c95e0c90e89249cf12746ae299a76c2c27e7fad49cfc5ecd84af77afe25da2748fde0d2072bf92a8b827b484e5cff6af280fd38c73efbdc04101f3b1a'
    }]
    const result = JSON.parse(truncateWsMessage(JSON.stringify(example)))

    assert.equal(result[0], 'EVENT')
    assert.equal(result[1].sig, '34c...(128)')
    assert.equal(result[1].tags.length, 6)
    assert.equal(result[1].tags[5], '... and 15 more tags')
  })
})
