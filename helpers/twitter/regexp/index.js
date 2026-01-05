import regexSupplant from './regex-supplant.js'
import validGTLD from './valid-gtld.js'
import validCCTLD from './valid-cctld.js'

// simple string interpolation
function stringSupplant (str, map) {
  return str.replace(/#\{(\w+)\}/g, function (match, name) {
    return map[name] || ''
  })
}

const directionalMarkersGroup = /\u202A-\u202E\u061C\u200E\u200F\u2066\u2067\u2068\u2069/
const invalidCharsGroup = /\uFFFE\uFEFF\uFFFF/
const validUrlPrecedingChars = regexSupplant(
  /(?:[^A-Za-z0-9@＠$#＃#{invalidCharsGroup}]|[#{directionalMarkersGroup}]|^)/,
  {
    invalidCharsGroup,
    directionalMarkersGroup
  }
)

// escape characters are required cause the regex may be added inside parentheses /[...]/
// eslint-disable-next-line no-useless-escape
const punct = /\!'#%&'\(\)*\+,\\\-\.\/:;<=>\?@\[\]\^_{|}~\$/
// eslint-disable-next-line no-control-regex
const spacesGroup = /\x09-\x0D\x20\x85\xA0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000/
const invalidDomainChars = stringSupplant('#{punct}#{spacesGroup}#{invalidCharsGroup}#{directionalMarkersGroup}', {
  punct: punct.source,
  spacesGroup: spacesGroup.source,
  invalidCharsGroup: invalidCharsGroup.source,
  directionalMarkersGroup: directionalMarkersGroup.source
})

const validDomainChars = regexSupplant(/[^#{invalidDomainChars}]/, {
  invalidDomainChars
})
const validDomainName = regexSupplant(/(?:(?:#{validDomainChars}(?:-|#{validDomainChars})*)?#{validDomainChars}\.)/, {
  validDomainChars
})
const validSubdomain = regexSupplant(/(?:(?:#{validDomainChars}(?:[_-]|#{validDomainChars})*)?#{validDomainChars}\.)/, {
  validDomainChars
})
const validPunycode = /(?:xn--[-0-9a-z]+)/
const validDomain = regexSupplant(
  /(?:#{validSubdomain}*#{validDomainName}(?:#{validGTLD}|#{validCCTLD}|#{validPunycode}))/,
  { validDomainName, validSubdomain, validGTLD, validCCTLD, validPunycode }
)

const validPortNumber = /[0-9]+/

const cyrillicLettersAndMarks = /\u0400-\u04FF/
const latinAccentChars = /\xC0-\xD6\xD8-\xF6\xF8-\xFF\u0100-\u024F\u0253\u0254\u0256\u0257\u0259\u025B\u0263\u0268\u026F\u0272\u0289\u028B\u02BB\u0300-\u036F\u1E00-\u1EFF/
const validGeneralUrlPathChars = regexSupplant(
  // eslint-disable-next-line no-useless-escape
  /[a-z#{cyrillicLettersAndMarks}0-9!\*';:=\+,\.\$\/%#\[\]\-\u2013_~@\|&#{latinAccentChars}]/i,
  { cyrillicLettersAndMarks, latinAccentChars }
)
// Allow URL paths to contain up to two nested levels of balanced parens
//  1. Used in Wikipedia URLs like /Primer_(film)
//  2. Used in IIS sessions like /S(dfd346)/
//  3. Used in Rdio URLs like /track/We_Up_(Album_Version_(Edited))/
const validUrlBalancedParens = regexSupplant(
  '\\(' +
    '(?:' +
    '#{validGeneralUrlPathChars}+' +
    '|' +
    // allow one nested level of balanced parentheses
    '(?:' +
    '#{validGeneralUrlPathChars}*' +
    '\\(' +
    '#{validGeneralUrlPathChars}+' +
    '\\)' +
    '#{validGeneralUrlPathChars}*' +
    ')' +
    ')' +
    '\\)',
  { validGeneralUrlPathChars },
  'i'
)

// Valid end-of-path chracters (so /foo. does not gobble the period).
// 1. Allow =&# for empty URL parameters and other URL-join artifacts
const validUrlPathEndingChars = regexSupplant(
  /[+\-a-z#{cyrillicLettersAndMarks}0-9=_#/#{latinAccentChars}]|(?:#{validUrlBalancedParens})/i,
  { cyrillicLettersAndMarks, latinAccentChars, validUrlBalancedParens }
)

// Allow @ in a url, but only in the middle. Catch things like http://example.com/@user/
const validUrlPath = regexSupplant(
  '(?:' +
    '(?:' +
    '#{validGeneralUrlPathChars}*' +
    '(?:#{validUrlBalancedParens}#{validGeneralUrlPathChars}*)*' +
    '#{validUrlPathEndingChars}' +
    ')|(?:@#{validGeneralUrlPathChars}+/)' +
    ')',
  {
    validGeneralUrlPathChars,
    validUrlBalancedParens,
    validUrlPathEndingChars
  },
  'i'
)
// eslint-disable-next-line no-useless-escape
const validUrlQueryChars = /[a-z0-9!?\*'@\(\);:&=\+\$\/%#\[\]\-_\.,~|]/i
const validUrlQueryEndingChars = /[a-z0-9\-_&=#\/]/i
const extractUrl = regexSupplant(
  '(' + // $1 total match
  '(#{validUrlPrecedingChars})' + // $2 Preceeding chracter
  '(' + // $3 URL
  '(https?:\\/\\/)?' + // $4 Protocol (optional)
  '(#{validDomain})' + // $5 Domain(s)
  '(?::(#{validPortNumber}))?' + // $6 Port number (optional)
  '(\\/#{validUrlPath}*)?' + // $7 URL Path
  '(\\?#{validUrlQueryChars}*#{validUrlQueryEndingChars})?' + // $8 Query String
    ')' +
    ')',
  {
    validUrlPrecedingChars,
    validDomain,
    validPortNumber,
    validUrlPath,
    validUrlQueryChars,
    validUrlQueryEndingChars
  },
  'gi'
)

const invalidUrlWithoutProtocolPrecedingChars = /[-_./]$/

export {
  extractUrl,
  invalidUrlWithoutProtocolPrecedingChars
}
