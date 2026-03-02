import { createServer } from 'node:http'
import { addToCleanup } from '#helpers/process.js'
// eslint-disable-next-line n/no-deprecated-api
import { parse } from 'node:url'
import { getIp } from '#helpers/request.js'
import { rateLimitReqByIp } from '#services/rate-limiting/server-request-limiter.js'
import { parseNip50PathExtensions } from '#helpers/subscription.js'

const shouldSpinUpServer = process.env.NODE_ENV === 'development' || process.env.SHOULD_SPIN_UP_SERVER === 'true'
const server = shouldSpinUpServer
  ? createServer(httpOnlyHandler)
  : { on: () => server, listen: () => server }

export async function httpOnlyHandler (req, res) {
  try {
    console.dir(req.headers, { depth: null })
    logReqRes(req, res)
    await handleRequest(req, res)
  } catch (err) {
    console.error('Error occurred handling', req.url, err)
    res.statusCode = 500
    res.end('internal server error')
  }
}

const port = (process.env.PORT && parseInt(process.env.PORT, 10)) ?? (process.env.NODE_ENV === 'production' ? 80 : 8080)
const isDev = process.env.NODE_ENV !== 'production'
server
  .listen(port)
  .on('error', onError({ port }))
  .on('listening', onListening({ port, server, isDev }))
  .on('close', onClose)

function sendDefaultErrorResponse (res) {
  res.setHeader('content-type', 'application/json')
  res.writeHead(404)
  res.end(JSON.stringify({ error: { base: ['Resource not found'] } }))
}
function sendRateLimitResponnse (res, retrySecs) {
  res.setHeader('retry-after', String(retrySecs))
  res.writeHead(429)
  res.end(JSON.stringify({ errors: { base: ['Too Many Requests'] } }))
}
const RELAY_DOMAIN = process.env.RELAY_HOST || 'relay.44billion.net'
const BASE_RELAY_INFO = {
  pubkey: 'fc7085c383ba71745704bdc1c6efcf7fab0197501de598c5e6c537ac0b32a4cb', // arthurfranca - npub1l3cgtsurhfchg4cyhhqudm70074sr96srhje330xc5m6czej5n9s9q6vs2
  contact: 'https://github.com/arthurfranca',
  // just server-side nips
  supported_nips: ['1', '9', '11', '40', '42', '50'],
  software: 'Bananânia Relay Deluxe',
  version: '0.0.1'
}

const ICONS = {
  default: 'https://nostr.build/i/53866b44135a27d624e99c6165cabd76ac8f72797209700acb189fce75021f47.jpg',
  trending: 'https://nostr.build/i/53866b44135a27d624e99c6165cabd76ac8f72797209700acb189fce75021f47.jpg',
  spam: 'https://nostr.build/i/53866b44135a27d624e99c6165cabd76ac8f72797209700acb189fce75021f47.jpg',
  rising: 'https://nostr.build/i/53866b44135a27d624e99c6165cabd76ac8f72797209700acb189fce75021f47.jpg',
  popular: 'https://nostr.build/i/53866b44135a27d624e99c6165cabd76ac8f72797209700acb189fce75021f47.jpg'
}

const LANGUAGE_NAMES = {
  en: 'English', pt: 'Portuguese', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ru: 'Russian',
  ar: 'Arabic', hi: 'Hindi', tr: 'Turkish', nl: 'Dutch', pl: 'Polish',
  sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', cs: 'Czech',
  uk: 'Ukrainian', el: 'Greek', he: 'Hebrew', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', ro: 'Romanian', hu: 'Hungarian', bg: 'Bulgarian',
  hr: 'Croatian', sk: 'Slovak', sl: 'Slovenian', lt: 'Lithuanian', lv: 'Latvian',
  et: 'Estonian', ca: 'Catalan', eu: 'Basque', gl: 'Galician', tl: 'Tagalog'
}

function buildRelayInfoDocument (pathExtensions) {
  if (!pathExtensions) {
    return {
      name: '44billion.net Relay'.slice(0, 30),
      description: 'A free and sybil-resistant Nostr relay that respects your privacy.'.slice(0, 100),
      icon: ICONS.default,
      ...BASE_RELAY_INFO
    }
  }

  const { sortTop, isSpam, isRising, isPopular, language } = pathExtensions

  // Build language label
  const langLabel = language?.length
    ? language.map(l => LANGUAGE_NAMES[l] || l.toUpperCase()).join(' & ')
    : null

  // Determine the primary icon (sort:top > is:popular > is:rising > is:spam)
  let icon = ICONS.default
  if (sortTop) icon = ICONS.trending
  else if (isPopular) icon = ICONS.popular
  else if (isRising) icon = ICONS.rising
  else if (isSpam) icon = ICONS.spam

  // Build name and description based on extensions
  let name, description

  if (sortTop) {
    if (langLabel) {
      name = `Trending in ${langLabel}`
      description = `Trending notes in ${langLabel} of ${RELAY_DOMAIN}`
    } else {
      name = 'Trending'
      description = `Trending notes of ${RELAY_DOMAIN}`
    }
  } else if (isPopular) {
    if (langLabel) {
      name = `Influencers in ${langLabel}`
      description = `Notes from popular authors in ${langLabel} on ${RELAY_DOMAIN}`
    } else {
      name = 'Influencers'
      description = `Notes from popular authors on ${RELAY_DOMAIN}`
    }
  } else if (isRising) {
    if (langLabel) {
      name = `Rising in ${langLabel}`
      description = `Notes from rising authors in ${langLabel} on ${RELAY_DOMAIN}`
    } else {
      name = 'Rising'
      description = `Notes from rising authors on ${RELAY_DOMAIN}`
    }
  } else if (isSpam) {
    if (langLabel) {
      name = `Spam in ${langLabel}`
      description = `Spam-classified notes in ${langLabel} on ${RELAY_DOMAIN}`
    } else {
      name = 'Spam'
      description = `Spam-classified notes on ${RELAY_DOMAIN}`
    }
  } else if (langLabel) {
    name = langLabel
    description = `Notes in ${langLabel} on ${RELAY_DOMAIN}`
  } else {
    // Fallback: only include:spam was set, or some unexpected combination
    name = '44billion.net Relay'
    description = 'A free and sybil-resistant Nostr relay that respects your privacy.'
  }

  return {
    name: name.slice(0, 30),
    description: description.slice(0, 100),
    icon,
    ...BASE_RELAY_INFO
  }
}

export function handleRequest (req, res) {
  try {
    req.ip ??= getIp(req)
    const { isRateLimited, nextWindow } = rateLimitReqByIp(req)
    if (isRateLimited) {
      const retrySecs = Math.ceil(Math.max(0, nextWindow.getTime() - Date.now()) / 1000)
      return sendRateLimitResponnse(res, retrySecs)
    }

    // const parsedUrl = new URL(req.url, `https://${req.headers.host}`)
    const parsedUrl = parse(req.url, true) // legacy (not deprecated) but faster
    const { pathname /*, query */ } = parsedUrl

    if (pathname === '/' || pathname.startsWith('/.well-known/nip50/')) {
      if (req.method !== 'GET') {
        if (shouldSpinUpServer) return sendDefaultErrorResponse(res)
        // other handler may handle it
        return
      }

      // Validate NIP-50 path if present
      let pathExtensions = null
      if (pathname.startsWith('/.well-known/nip50/')) {
        pathExtensions = parseNip50PathExtensions(pathname)
        if (!pathExtensions) {
          if (shouldSpinUpServer) return sendDefaultErrorResponse(res)
          return
        }
      }

      // In fact, this header won't be present as node:http will have already triggered 'upgrade' event
      // if (req.headers.connection === 'Upgrade') return // handle at server.on('upgrade')

      if (req.headers.accept === 'application/nostr+json') {
        const relayInformationDocument = buildRelayInfoDocument(pathExtensions)

        res.setHeader('content-type', 'application/nostr+json')
        res.setHeader('access-control-allow-origin', '*')
        res.writeHead(200)
        const body = JSON.stringify(relayInformationDocument)
        res.end(body)
      } else if (shouldSpinUpServer) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: { base: ['Please connect with a Nostr client'] } }))
      }
    } else {
      if (shouldSpinUpServer) return sendDefaultErrorResponse(res)
    }
  } catch (err) {
    if (!shouldSpinUpServer) return console.log(err)
    res.writeHead(500)
    res.end(err)
  }
}

function logReqRes (req, res) {
  console.log(`${req.method} ${req.url} (fwd: ${req.headers['x-forwarded-for']} - sckt: ${req.socket.remoteAddress})`)
  req.on('error', err => { console.error(`Request error: ${err.stack}`) })
  res.on('error', err => { console.error(`Response error: ${err.stack}`) })
}

function onError ({ port }) {
  return error => {
    if (error.syscall !== 'listen') throw error

    switch (error.code) {
      case 'EACCES':
        console.error(`Port ${port} requires elevated privileges`)
        process.kill(process.pid, 'SIGINT')
        break
      case 'EADDRINUSE':
        console.error(`Port ${port} is already in use`)
        process.kill(process.pid, 'SIGINT')
        break
      default:
        throw error
    }
  }
}

function onListening ({ port, /* isDev, */ server }) {
  return () => {
    console.log(`> Ready on http://localhost:${port}`)
    addToCleanup(server.close.bind(server))
    // if (isDev) return

    // process.send?.('ready') // send the ready signal to pm2
  }
}

function onClose () {
  console.log(`Server closed at ${new Date().toLocaleString('pt-br', { timeZone: 'America/Sao_Paulo' })}`)
}

export default server
