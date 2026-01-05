import { rateLimitByKey, getIp } from '#helpers/request.js'

function rateLimitReqByIp (req) {
  const ip = getIp(req)
  return rateLimitByKey({ key: 'request::' + ip, reqsPerWindow: 12, windowSeconds: 2 })
}

export {
  rateLimitReqByIp
}
