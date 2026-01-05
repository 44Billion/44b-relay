import * as secp256k1 from '@noble/secp256k1'
import { eventTags, eventKinds } from '#constants/event.js'
import { webSocketRegExp } from '#constants/web-socket.js'
import { hostnameRegExp, urlRegExp, imageDataUrlRegExp } from '#constants/url.js'
import { nostrClientMessages } from '#constants/message.js'
import { isKnownEventKind, serializeEvent, isParameterizedReplaceableEvent } from '#helpers/event.js'
import { isType } from '#helpers/shared.js'

export default class EventValidator {
  constructor ({ event, clientMessage }) {
    Object.assign(this, { event, clientMessage })
  }

  static run (event) {
    return new this(event).isValid()
  }

  // don't make async checks cause client expect relay auth to be sync
  isValid () {
    const message = this.getValidationMessage()
    return { isSuccess: !message, message: message ? `invalid: ${message}` : '' }
  }

  getValidationMessage () {
    const { event } = this

    if (!event || !isType(event, 'object')) return 'wrong event'
    if (!this.doesMessageAllowKind()) return 'wrong event kind'
    if (!this.hasValidEventAttributes()) return 'wrong attribute(s)'
    if (!isKnownEventKind(event.kind)) return 'unknown event kind'
    if (!this.hasValidEventId()) return 'wrong event id'
    if (!this.hasValidEventSignature()) return 'wrong event sig'
    if (!this.hasValidKnownTags()) return 'wrong tag(s)'
    if (!this.hasValidData()) return 'wrong data'

    return ''
  }

  async doesMessageAllowKind () {
    const { event: { kind }, clientMessage } = this
    if (!clientMessage) return true
    if (![nostrClientMessages.AUTH, nostrClientMessages.EVENT].includes(clientMessage)) return false
    if (kind === eventKinds.AUTH && clientMessage !== nostrClientMessages.AUTH) return false

    return true
  }

  hasValidEventAttributes = (() => {
    function hasValidSimpleEventAttributes (event) {
      if (!isType(event.content, 'string')) return false
      if (!isType(event.pubkey, 'string')) return false
      if (!isType(event.kind, 'number')) return false
      if (!isType(event.created_at, 'number')) return false
      if (!/^[0-9a-f]{64}$/.test(event.pubkey)) return false
      if (!Array.isArray(event.tags)) return false
      for (const tag of event.tags) {
        if (!Array.isArray(tag)) return false
        if (tag.some(v => !isType(v, 'string'))) return false
      }

      return true
    }

    return function hasValidEventAttributes () {
      const { event } = this
      if (Object.keys(event).length !== 7) return false
      if (!isType(event.sig, 'string')) return false
      if (!isType(event.id, 'string')) return false
      if (!hasValidSimpleEventAttributes(event)) return false

      return true
    }
  })()

  hasValidEventId () {
    try {
      const { event } = this
      const eventHash = secp256k1.utils.sha256Sync(Buffer.from(serializeEvent(event)))
      return Buffer.from(eventHash).toString('hex') === event.id
    } catch (err) {
      return false
    }
  }

  hasValidEventSignature () {
    try {
      const { event: { id: eventHash, sig, pubkey } } = this
      return secp256k1.schnorr.verifySync(sig, eventHash, pubkey)
    } catch (err) {
      return false
    }
  }

  hasValidKnownTags () {
    const { event, event: { tags, pubkey } } = this
    const tagCount = [
      eventTags.CHALLENGE,
      eventTags.DELEGATION,
      eventTags.EXPIRATION,
      eventTags.PUBLISHED_AT,
      eventTags.RELAY,
      eventTags.SUBJECT,
      eventTags.SUMMARY,
      eventTags.TITLE
    ].reduce((memo, item) => { memo[item] = 0; return memo }, {})
    for (const tag of tags) {
      switch (tag[0]) {
        case eventTags.ADDRESS: {
          if (tag.length < 2 || tag.length > 3 || (![undefined, ''].includes(tag[2]) && !webSocketRegExp.test(tag[2]))) return false
          let [kind, pubkey, ...deduplicationId] = tag[1]?.split?.(':') ?? []
          deduplicationId = deduplicationId.join(':')
          try { kind = parseInt(kind, 10) } catch (err) { return false }
          if (!isParameterizedReplaceableEvent({ kind }) || !/^[0-9a-f]{64}$/.test(pubkey) || !deduplicationId) return false
          break
        }
        case eventTags.CHALLENGE: { if (++tagCount[eventTags.CHALLENGE] > 1 || tag.length !== 2 || !isType(tag[1], 'string') || tag[1] === '') return false; break }
        case eventTags.DEDUPLICATION: { if (tag.length > 1 && !isType(tag[1], 'string')) return false; break }
        case eventTags.DELEGATION: {
          if (++tagCount[eventTags.DELEGATION] > 1) return false
          const [tagName, delegatorPubkey, conditionsQueryString, delegationSig] = tag
          if (!isType(delegatorPubkey, 'string') || !/^[0-9a-f]{64}$/.test(delegatorPubkey)) return false
          if (!isType(conditionsQueryString, 'string')) return false
          if (!isType(delegationSig, 'string')) return false

          // https://github.com/nbd-wtf/nostr-tools/blob/901445dea118399c248e20ad128f1c58d8c48046/nip26.ts#L61
          function hasValidConditions () {
            const conditions = conditionsQueryString.split('&') // '' => ['']
            let pendingKindConditionFulfillment
            for (const condition of conditions) {
              const [key, operator, value] = condition.split(/\b/)

              // the supported conditions are just 'kind' and 'created_at' for now
              if (key === 'kind') {
                if (operator !== '=') return false
                if (event.kind === parseInt(value, 10)) {
                  pendingKindConditionFulfillment = false
                  continue
                } else if (pendingKindConditionFulfillment === undefined) {
                  pendingKindConditionFulfillment = true
                  continue
                }
              } else if (key === 'created_at') {
                if (operator === '<' && event.created_at < parseInt(value, 10)) continue
                else if (operator === '>' && event.created_at > parseInt(value, 10)) continue
                else return false
              } else return false // invalid condition
            }
            if (pendingKindConditionFulfillment) return false

            return true
          }
          if (!hasValidConditions()) return false

          function hasValidDelegationSignature () {
            try {
              const delegationToken = `nostr:${tagName}:${pubkey}:${conditionsQueryString}`
              const msgHash = secp256k1.utils.sha256Sync(Buffer.from(delegationToken))
              return secp256k1.schnorr.verifySync(delegationSig, msgHash, delegatorPubkey)
            } catch (err) {
              return false
            }
          }
          if (!hasValidDelegationSignature()) return false
          break
        }
        case eventTags.EVENT: { if (tag.length < 2 || tag.length > 3 || !/^[0-9a-f]{64}$/.test(tag[1]) || (![undefined, ''].includes(tag[2]) && !webSocketRegExp.test(tag[2]))) return false; break }
        case eventTags.EXPIRATION: {
          if (++tagCount[eventTags.EXPIRATION] > 1 || tag.length !== 2) return false
          let expiration
          try { expiration = parseInt(tag[1], 10) } catch (err) {}
          if (!isType(expiration, 'number') || expiration < -8640000000000 || expiration > 8640000000000) return false
          break
        }
        case eventTags.HASHTAG: { if (tag.length !== 2 || !isType(tag[1], 'string') || tag[1] === '') return false; break }
        case eventTags.IMAGE: { if (tag.length !== 2 || (!urlRegExp.test(tag[1]) && !imageDataUrlRegExp.test(tag[1]))) return false; break }
        case eventTags.LANGUAGE: { if (tag.length !== 2 || !/[a-z]{2}(-[A-Z]{2})?/.test(tag[1])) return false; break }
        case eventTags.NONCE: { if (tag.length < 2 || tag.length > 3 || !/^[0-9]$/.test(tag[1]) || (![undefined, ''].includes(tag[2]) && !/^[0-9]$/.test(tag[2]))) return false; break }
        case eventTags.PUBKEY: { if (tag.length < 2 || tag.length > 3 || !/^[0-9a-f]{64}$/.test(tag[1]) || (![undefined, ''].includes(tag[2]) && !webSocketRegExp.test(tag[2]))) return false; break }
        case eventTags.PUBLISHED_AT: {
          if (++tagCount[eventTags.PUBLISHED_AT] > 1) return false
          if (tag.length !== 2 || !isType(tag[1], 'string') || tag[1] === '') return false
          let publishedAt
          try { publishedAt = parseInt(tag[1]) } catch (err) { return false }
          if (!isType(publishedAt, 'number') || publishedAt < event.created_at || publishedAt < -8640000000000 || publishedAt > 8640000000000) return false
          break
        }
        case eventTags.RELAY: { if (++tagCount[eventTags.RELAY] > 1 || tag.length !== 2 || !webSocketRegExp.test(tag[1])) return false; break }
        // could be other types of reference but we will support urls/wss only because of how it was adopted (web comments and relay list metadata)
        case eventTags.REFERENCE: { if (tag.length !== 2 || (!urlRegExp.test(tag[1]) && !webSocketRegExp.test(tag[1]))) return false; break }
        case eventTags.SUBJECT: {
          if (++tagCount[eventTags.SUBJECT] > 1) return false
          if (tag.length !== 2 || !isType(tag[1], 'string') || tag[1].length > 80) return false; break
        }
        case eventTags.SUMMARY: {
          if (++tagCount[eventTags.SUMMARY] > 1) return false
          if (tag.length !== 2 || !isType(tag[1], 'string') || tag[1].length > 280) return false; break
        }
        case eventTags.TITLE: {
          if (++tagCount[eventTags.TITLE] > 1) return false
          if (tag.length !== 2 || !isType(tag[1], 'string') || tag[1].length > 150) return false; break
        }
      }
    }
    return true
  }

  // TODO: other kinds (custom dont handle unused kinds - allow just metadata and 1 at beggining), saver and rate limit
  hasValidData () {
    const { event: { kind, content, tags } } = this
    switch (kind) {
      case eventKinds.TEXT_NOTE: {
        try {
          const json = JSON.parse(content)
          if (!['null', '[]', '{}'].includes(json)) return false
        } catch (err) {}
        break
      }
      case eventKinds.METADATA: {
        try {
          const { name: username, about, picture, nip05, nip05valid, npub, followersCount, iris, display_name, displayName, banner, website, lud06, lud16 /*, ...rest */ } = JSON.parse(content)
          // if (Object.keys(rest).length > 0) return false
          if (![undefined, ''].includes(username) && (!isType(username, 'string') || username.length > 70)) return false
          if (![undefined, ''].includes(about) && (!isType(about, 'string') || about.length > 400)) return false
          if (![undefined, ''].includes(picture) && !urlRegExp.test(picture) && !imageDataUrlRegExp.test(picture)) return false
          if (![undefined, ''].includes(nip05)) {
            const [username, hostname] = nip05.split('@')
            if (!/[A-z0-9-_.]+/.test(username) || username.length > 70 || !hostnameRegExp.test(hostname)) return false
          }
          // v custom v
          if (![undefined, ''].includes(nip05valid) && ![true, false].includes(nip05valid)) return false
          if (![undefined, ''].includes(npub) && !/^npub1[ac-hj-np-z02-9]{58}$/.test(npub)) return false
          if (![undefined, ''].includes(followersCount)) {
            let count
            try { count = parseInt(followersCount) } catch (err) { return false }
            if (!isType(count, 'number')) return false
          }
          // iris nostr (and other protocols) client
          if (![undefined, ''].includes(iris)) {
            // e.g.: iris: "{\"pub\":\"ZSPElwznsNYf953qlQX8ZH8Dral81Z0EEQ-bsRcW_j8._OIQ2hiLV-YY4lFk6iCVMUS-BDB4BuoN6ZIUnNl96U8\",\"sig\":\"aSEA{\\\"m\\\":\\\"0695cb75dbb27d935a9b97e1a8b7ccd335076b0ced0ec88aa8d3a3bf129ee74f\\\",\\\"s\\\":\\\"hqBAuzcrwk8+yrOLQm4oOGKiYIU7AWbh6zcGKtvH6QQA+w6ik3K1dxiRL3qnVGkDniKl3GTBWjJlj6NFrqaJNA==\\\"}\"}"
            try { if (!isType(JSON.parse(iris), 'object')) return false } catch (err) { return false }
          }
          if (![undefined, ''].includes(display_name) && (!isType(display_name, 'string') || display_name.length > 70)) return false
          if (![undefined, ''].includes(displayName) && (!isType(displayName, 'string') || displayName.length > 70)) return false
          if (![undefined, ''].includes(banner) && !urlRegExp.test(banner) && !imageDataUrlRegExp.test(banner)) return false
          if (![undefined, ''].includes(website) && !urlRegExp.test(website)) return false
          if (![undefined, ''].includes(lud06) && (!urlRegExp.test(lud06) && !/^(lightning:)?(lnurl|lnbc)[a-z0-9]*1[ac-hj-np-z02-9]+$/i.test(lud06))) return false
          if (![undefined, ''].includes(lud16)) {
            if (!isType(lud16, 'string')) return false
            const [username, hostname] = lud16.split('@')
            if (!/[a-z0-9-_.]+/.test(username) || !hostnameRegExp.test(hostname)) return false
          }
        } catch (err) {
          return false
        }
        break
      }
      case eventKinds.REACTION: {
        const someHigherThan1LengthEmojis = ['🤙', '❤️']
        if (
          !['+', '-', ...someHigherThan1LengthEmojis].includes(content) &&
          // 1 length so to not allow two emojis. the regexp doesn't support multi char emojis such as 👨‍👩‍👧
          !/^\p{Extended_Pictographic}$/u.test(content)
        ) return false
        // block reactions with more than 1 p tag (should notify just the liked event/address/profile p)
        // block reactions with more than 1 e/a tag (querying #e should bring reactions directed to the #e only)
        // d is not documented but ideally reactions should be parameterized replaceable events
        const tagCount = { [eventTags.PUBKEY]: 0, [eventTags.EVENT]: 0, [eventTags.ADDRESS]: 0, [eventTags.DEDUPLICATION]: 0 }
        const interestingTags = Object.keys(tagCount)
        for (const tag of tags) {
          if (!interestingTags.includes(tag[0])) continue
          if (++tagCount[tag[0]] > 1) return false
        }
        // if https://github.com/nostr-protocol/nips/pull/264 doesn't land, keep compatibility even if using undocumented d tag
        if (tagCount[eventTags.PUBKEY] !== 1 || tagCount[eventTags.EVENT] !== 1) return false
        break
      }
    }

    return true
  }
}
