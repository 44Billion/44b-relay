// remove protocol and prefix; clear query params if has path
// 'https://www.bla.com/p/?g=4&g=43&b=&u2=3&z=&b=9&utm_medium=dsads&b=8&afsrc=1' => 'bla.com/p'
// 'https://www.bla.com/?g=4&g=43&b=&u2=3&z=&b=9&utm_medium=dsads&b=8&afsrc=1' => 'bla.com?b=9&b=8&g=4&g=43'
function toUrlId (url) {
  if (!url) return ''
  let obj
  try {
    obj = new URL(url)
  } catch (err) { console.log(`toUrlId error for (${url})`, err) }
  if (!obj) return ''

  let {
    hash, // "#dd"
    hostname, // "www.shopee.com.br"
    pathname // "/" or even "///"
    // search // "?a=2"
  } = obj
  // / => '' and ///a///a/// => /a/a
  pathname = pathname.replace(/\/+/g, '/').replace(/\/$/, '')
  // remove prefix
  const domain = hostname.replace(
    /^(www?\d*|web|app|link|page|download|mobile|m)\./,
    ''
  )

  // 3 path parts is safe to consider as enough to reach a product without query params
  // considering stores use seo urls
  // if ((pathname.match(/\//g) || []).length < 3) {
  // But we will risk it and add search params only when pathname === ''
  // so that user can't spam with many equal products with !== search params
  if (pathname === '') {
    normalizeSearchParams(obj)
    const { search } = obj
    return domain + pathname + search + (search ? '' : hash)
  } else {
    // We had to add search because of some urls like ab tests from campaign.aliexpress.com/wow/gcp/tesla-pc-new/index
    // with pathname that does not lead to product page if not adding search
    // return domain + pathname + search + (search ? '' : hash)
    // But will go back to old way so to save space (less url variations)
    return domain + pathname
  }
}

function normalizeSearchParams (obj) {
  ;[
    // Affiliate source https://en-academic.com/dic.nsf/enwiki/6548741
    'afsrc',
    // Google Analytics
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    // Custom params (may have from u1 up to u100 but it is unusual to have so many)
    ...[...Array(100)].map((_, i) => `u${++i}`)
  ].forEach(k => obj.searchParams.delete(k))
  // delete empty
  const presentValueKeys = {}
  const emptyValueKeys = {}
  obj.searchParams.forEach((v, k) => {
    if (v) {
      presentValueKeys[k] ??= []
      presentValueKeys[k].push(v)
    } else emptyValueKeys[k] = true
  })
  Object.keys(emptyValueKeys).forEach(k => {
    obj.searchParams.delete(k) // delete empty and present instances of the key
    ;(presentValueKeys[k] || []).forEach(v => obj.searchParams.append(k, v)) // recover present instances of key keeping order
  })
  // this won't sort repeated key instance by value, cause they could be part of an array (order matters)
  obj.searchParams.sort()
}

export {
  toUrlId
}
