/**
 * Job: Generate Localized Topic Assertion Events (kind 30385)
 *
 * Runs every 10 minutes. For each language with hashtagStats data,
 * fetches the top topics by count, generates signed addressable Nostr
 * events (kind 30385) with neighbor `t` tags, and queues them as
 * MeiliSearch event documents. Stale events from processed languages
 * that weren't refreshed are queued for deletion.
 *
 * Also resolves topic icons via multiple external providers (Wikipedia,
 * Wikidata, DuckDuckGo, Google Favicon) with fallback + backoff, and
 * includes the icon URL in an `icon` tag when available.
 */
import mdb from '#services/db/mdb.js'
import { finalizeEvent } from 'nostr-tools'
import { getRelaySelfSecretBytes, getRelaySelfPubkey } from '#helpers/relay-self.js'
import { eventToRecord, addressToRef } from '#models/event/mapper.js'
import { queueOps } from '#services/event/maintainer/mdb/index.js'
import { eventKinds } from '#constants/event.js'
import { resolveIconsBatch } from '#services/topic/icon-resolver.js'
import { patchIcons } from '#models/hashtag-stats/dao.js'

const MAX_TOPICS_PER_LANG = 30
const MAX_NEIGHBORS_PER_TOPIC = 20
const MIN_TOPIC_COUNT = 3

export async function run () {
  console.log('Running generate-localized-topic-assertion-events...')

  const secretKey = getRelaySelfSecretBytes()
  const pubkey = getRelaySelfPubkey()
  const kind = eventKinds.I_TAG_TRUSTED_ASSERTION

  // 1. Discover languages with stats
  const languages = await discoverLanguages()
  if (languages.length === 0) {
    console.log('No hashtagStats languages found, skipping.')
    return
  }

  for (const lang of languages) {
    try {
      await processLanguage({ lang, pubkey, secretKey, kind })
    } catch (err) {
      console.error(`Failed to process localized topic assertion events for lang=${lang}:`, err)
    }
  }

  console.log('Done generate-localized-topic-assertion-events.')
}

async function discoverLanguages () {
  try {
    const { facetDistribution } = await mdb.index('hashtagStats').search('', {
      limit: 0,
      facets: ['lang']
    })
    return Object.keys(facetDistribution?.lang || {})
  } catch (err) {
    if (err.code === 'index_not_found' || err.cause?.code === 'index_not_found') return []
    throw err
  }
}

/**
 * Compute a 1–100 rank from position index and total count.
 * Position 0 (highest) → 100, last position → 1.
 */
function positionToRank (position, total) {
  if (total <= 1) return 100
  return Math.max(1, Math.round(100 - (position / (total - 1)) * 99))
}

/**
 * Normalize neighbor co-occurrence counts to 1–100 relative ranks.
 * The neighbor with the highest count gets 100, lowest gets 1.
 */
function normalizeNeighborRanks (neighbors) {
  if (neighbors.length === 0) return []
  if (neighbors.length === 1) return [[neighbors[0][0], 100]]

  const maxCount = neighbors[0][1] // already sorted desc
  const minCount = neighbors[neighbors.length - 1][1]
  const range = maxCount - minCount

  return neighbors.map(([tag, count]) => {
    const rank = range === 0 ? 100 : Math.max(1, Math.round(((count - minCount) / range) * 99 + 1))
    return [tag, rank]
  })
}

/**
 * Resolves icons for tags that don't already have a cached icon URL.
 * Persists newly resolved icons back to hashtagStats documents.
 * Returns a Map<tag, iconUrl> of the newly resolved icons.
 */
async function resolveNewIcons (topTopics, lang) {
  const needsIcon = topTopics.filter(s => !s.icon)
  if (needsIcon.length === 0) return new Map()

  const items = needsIcon.map(s => ({ tag: s.tag, lang }))
  let iconMap
  try {
    iconMap = await resolveIconsBatch(items)
  } catch (_err) {
    return new Map()
  }

  // Persist resolved icons back in hashtagStats so we don't re-fetch next run.
  // Use the shared DAO which performs a single updateDocumentsByFunction call.
  if (iconMap.size > 0) {
    const iconByKey = {}
    for (const [tag, url] of iconMap) {
      iconByKey[`${lang}-${tag}`] = url
    }

    try {
      await patchIcons(iconByKey)
    } catch (_err) {
      console.error('Failed to persist icons:', _err)
    }
  }

  return iconMap
}

async function processLanguage ({ lang, pubkey, secretKey, kind }) {
  // 2. Fetch top topics for this language
  const { hits: topTopics } = await mdb.index('hashtagStats').search('', {
    filter: `lang = ${mdb.toMeiliValue(lang)} AND count >= ${MIN_TOPIC_COUNT}`,
    sort: ['count:desc'],
    limit: MAX_TOPICS_PER_LANG
  })

  if (topTopics.length === 0) return

  // 2b. Resolve icons for tags that don't already have one cached
  const iconMap = await resolveNewIcons(topTopics, lang)

  // 2c. Build a tag→words map. Seed it from topTopics, then batch-fetch
  //     any neighbor tags whose stats weren't included in the top-N window.
  const wordsMap = new Map(topTopics.map(s => [s.tag, s.words]))
  const missingNeighborTags = new Set()
  for (const stat of topTopics) {
    for (const [neighborTag] of stat.neighbors || []) {
      if (!wordsMap.has(neighborTag)) missingNeighborTags.add(neighborTag)
    }
  }
  if (missingNeighborTags.size > 0) {
    const tagFilter = [...missingNeighborTags].map(t => mdb.toMeiliValue(t)).join(', ')
    const { hits: neighborStats } = await mdb.index('hashtagStats').search('', {
      filter: `lang = ${mdb.toMeiliValue(lang)} AND tag IN [${tagFilter}]`,
      limit: missingNeighborTags.size
    })
    for (const hit of neighborStats) wordsMap.set(hit.tag, hit.words)
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const ops = []
  const refreshedRefs = new Set()
  const totalTopics = topTopics.length

  // 3. Generate a signed event per topic
  for (let position = 0; position < totalTopics; position++) {
    const stat = topTopics[position]
    const tag = stat.tag
    const dTag = `iso639:${lang}:#${tag}`
    const topicRank = positionToRank(position, totalTopics)

    // Build neighbor `t` tags (sorted by co-occurrence count desc)
    const neighbors = (stat.neighbors || [])
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_NEIGHBORS_PER_TOPIC)

    const rankedNeighbors = normalizeNeighborRanks(neighbors)

    // Determine icon: prefer cached icon from hashtagStats, then newly resolved
    const iconUrl = stat.icon || iconMap.get(tag) || null

    const tags = [
      ['d', dTag],
      ['k', 'iso639:#'],
      ['rank', String(topicRank)],
      ['l', `iso639:${lang}`],
      ['t', tag, stat.words?.join(' ') ?? '']
    ]

    if (iconUrl) {
      tags.push(['icon', iconUrl])
    }

    for (const [neighborTag, neighborRank] of rankedNeighbors) {
      tags.push(['t', neighborTag, wordsMap.get(neighborTag)?.join(' ') ?? '', String(neighborRank)])
    }

    // Use descending created_at by position so higher-count topics sort first
    // eslint-disable-next-line camelcase
    const created_at = nowSeconds - position

    const unsignedEvent = {
      kind,
      created_at, // eslint-disable-line camelcase
      tags,
      content: ''
    }

    const signedEvent = finalizeEvent(unsignedEvent, secretKey)

    // Convert to MeiliSearch record
    const record = eventToRecord(signedEvent, {
      language: lang,
      receivedAt: nowSeconds
    })

    const ref = addressToRef({ kind, pubkey, dTag })
    refreshedRefs.add(ref)

    ops.push({
      type: 'insertOrReplaceDocument',
      data: {
        index: 'events',
        document: {
          ...record,
          byteSize: JSON.stringify(signedEvent).length,
          ownerType: 'pubkey',
          popularityLevel: 1
        }
      }
    })
  }

  // 4. Find stale events for this language that weren't refreshed
  const staleFilter = [
    `pubkey = ${mdb.toMeiliValue(pubkey)}`,
    `kind = ${mdb.toMeiliValue(kind)}`,
    `language = ${mdb.toMeiliValue(lang)}`
  ].join(' AND ')

  let offset = 0
  const BATCH = 100
  while (true) {
    const { hits } = await mdb.index('events').search('', {
      filter: staleFilter,
      limit: BATCH,
      offset
    })
    if (hits.length === 0) break

    for (const hit of hits) {
      if (!refreshedRefs.has(hit.ref)) {
        ops.push({
          type: 'deleteDocumentIfExists',
          data: { index: 'events', key: hit.ref }
        })
      }
    }
    offset += hits.length
    if (hits.length < BATCH) break
  }

  if (ops.length > 0) {
    console.log(`Localized topic assertion events for lang=${lang}: ${ops.length} ops (${refreshedRefs.size} upserts)`)
    await queueOps(ops)
  }
}

const config = {
  key: 'generateLocalizedTopicAssertionEvents',
  frequency: 10 * 60, // Every 10 minutes
  shouldUseLock: true,
  run
}

export default config
