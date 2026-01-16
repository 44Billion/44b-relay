import { rateLimitByKey, getIp } from '#helpers/request.js'

const reqsPerWindow = process.env.IS_INTEGRATION_TEST === 'true' ? 1000 : 12
function rateLimitReqByIp (req) {
  const ip = getIp(req)
  return rateLimitByKey({ key: 'request::' + ip, reqsPerWindow, windowSeconds: 2 })
}

export {
  rateLimitReqByIp
}
