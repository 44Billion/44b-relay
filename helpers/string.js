import { extractUrl, invalidUrlWithoutProtocolPrecedingChars } from '#helpers/twitter/regexp/index.js'

function getUrls (text, { howMany = null, fallbackProtocol = null, onlyDomain = false } = {}) {
  const regex = extractUrl
  regex.lastIndex = 0 // it has g flag

  const urls = []
  let matchArray
  const isHowManyANumber = Number.isInteger(howMany)
  // eslint-disable-next-line no-unmodified-loop-condition
  while ((!isHowManyANumber || howMany) && (matchArray = regex.exec(text))) {
    let [, , before, url, protocol, domain] = matchArray
    if (!protocol && before.match(invalidUrlWithoutProtocolPrecedingChars)) continue

    // will only add protocol if there is fallbackProtocol
    if (onlyDomain) url = [fallbackProtocol && protocol, domain].filter(Boolean).join('')
    if (!protocol && fallbackProtocol) url = [fallbackProtocol, url].join('')

    urls.push(url)
    isHowManyANumber && howMany--
  }

  return urls
}

export {
  getUrls
}
