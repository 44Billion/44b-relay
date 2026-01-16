export const ipToPrimaryKey = ip => Buffer.from(ip).toString('base64url')
export const primaryKeyToIp = key => Buffer.from(key, 'base64url').toString('utf8')
export const isValidPrimaryKey = key => Number.isInteger(key) || /^[A-Za-z0-9_-]+$/.test(key)
