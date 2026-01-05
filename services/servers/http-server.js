import { createServer } from 'node:http'
import { addToCleanup } from '#helpers/process.js'
// eslint-disable-next-line n/no-deprecated-api
import { parse } from 'node:url'
import { getIp } from '#helpers/request.js'
import { rateLimitReqByIp } from '#services/rate-limiting/server-request-limiter.js'

// const server = createServer(httpOnlyHandler)
const server = { on: () => server, listen: () => server }
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
export function handleRequest (req, res) {
  try {
    req.ip = getIp(req)
    const { isRateLimited, nextWindow } = rateLimitReqByIp(req)
    if (isRateLimited) {
      const retrySecs = Math.ceil(Math.max(0, nextWindow.getTime() - Date.now()) / 1000)
      return sendRateLimitResponnse(res, retrySecs)
    }

    // const parsedUrl = new URL(req.url, `https://${req.headers.host}`)
    const parsedUrl = parse(req.url, true) // legacy (not deprecated) but faster
    const { pathname /*, query */ } = parsedUrl
    switch (pathname) {
      case '/': {
        // other handler may handle it
        if (req.method !== 'GET') return // return sendDefaultErrorResponse(res)
        // In fact, this header won't be present as node:http will have already triggered 'upgrade' event
        // if (req.headers.connection === 'Upgrade') return // handle at server.on('upgrade')

        if (req.headers.accept === 'application/nostr+json') {
          const relayInformationDocument = {
            name: '44billion.net'.slice(0, 30),
            // description: '',
            // pubkey: '',
            // contact: '',
            // just server-side nips
            supported_nips: [1, 11]
            // software: '',
            // version: ''
          }

          res.setHeader('content-type', 'application/nostr+json')
          res.setHeader('access-control-allow-origin', '*')
          res.writeHead(200)
          const body = JSON.stringify(relayInformationDocument)
          res.end(body)
        } /* else {
          res.setHeader('content-type', 'application/json')
          res.end({ error: { base: ['Please connect with a Nostr client'] } })
        } */

        break
      }
      // default:
      //   return sendDefaultErrorResponse(res)
    }
  } catch (err) {
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

function onListening ({ port, isDev, server }) {
  return () => {
    console.log(`> Ready on http://localhost:${port}`)
    addToCleanup(server.close.bind(server))
    if (isDev) return

    process.send?.('ready') // send the ready signal to pm2
  }
}

function onClose () {
  console.log(`Server closed at ${new Date().toLocaleString('pt-br', { timeZone: 'America/Sao_Paulo' })}`)
}

export default server
