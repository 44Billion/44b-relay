function getQueryKeyWithOperator (k, v) {
  switch (k) {
    case 'ids':
    case 'authors': return v.length === 64 ? k.slice(0, -1) : `${k.slice(0, -1)}?pfx`
    case 'kinds': return v.slice(0, -1)
    case 'since': return 'published_at?gt'
    case 'until': return 'published_at?lt'
    default: {
      // Generic Tag Queries - we will keep db field as #x instead of hashtags.x
      if (k[0] === '#') return `${k}?contains`
      throw new Error('Unknown filter key')
    }
  }
}

export default getQueryKeyWithOperator
