// https://github.com/deta/cloud-docs/discussions/344
// deta base uses DynamoDB with key always asc sorted strings
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.NamingRulesDataTypes.html
// Strings are Unicode with UTF-8 binary encoding
// DynamoDB collates and compares strings using the bytes of the underlying UTF-8 string encoding.
// For example, "a" (0x61) is greater than "A" (0x41), and "¿" (0xC2BF) is greater than "z" (0x7A).
// Limits: 400kB per row | 16 digit integers (use strings for larger ints) | 10 GB of Drive space per account
// import { Deta } from 'deta'

const getRandomFixedLengthId = (() => {
  // safe DynamoDB chars
  const alphabet = '._-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const getRandomChar = () => alphabet[Math.floor(Math.random() * alphabet.length)]

  return function getRandomFixedLengthId (length) {
    return [...Array(length)].map(() => getRandomChar()).join('')
  }
})()

// We will use seconds because Number.MAX_SAFE_INTEGER < (8.64e15 + 8.64e15)
const maxDateNowSeconds = 8.64e15 / 1000
// The - sign (string) won't make -2 (or -02) lower than -1 (or -01) so - and no sign would have opposite sort order
// So to make -maxDateNowSeconds positive we sum with maxDateNowSeconds
const maxTs = maxDateNowSeconds * 2
const maxSecondsLength = (maxDateNowSeconds * 2).toString().length
const randomIdSize = 5 // the higher size the lower collision probability

// The default deta base keys are incremental and the only sort order is asc
// So if we want the oldest item first (desc), the keys must get smaller as items get older
// This defaults to desc which is expected by nostr queries
function generateKey ({ timestampMs = Date.now(), ascending = false, id }) {
  const secondsFloat = timestampMs / 1000
  // Better than Math.floor(value) because it works wih negative values -33.3 => -33 instead of -34
  const seconds = Math.trunc(secondsFloat)
  const paddedMs = (secondsFloat % 1).toFixed(3).split('.')[1] // .1 => 100 .01 => 010 (000 up to 999 miliseconds)
  const ts = seconds + maxDateNowSeconds // make -maxDateNowSeconds positive (so will allow negative ts)
  // maxTs - ts will make the value lower the greater the ts is (the newer)
  const paddedTsSeconds = (ascending ? (maxTs - ts) : ts).toString().padStart(maxSecondsLength, '0')
  // if timestampMs and id are both provided (with same sort order), the key will be always the same
  const randomFixedLengthId = id || getRandomFixedLengthId(randomIdSize)
  // padding so to sort strings correctly as 1111 is lower than 2 but not than 0002
  return `${paddedTsSeconds}${paddedMs}${randomFixedLengthId}`
}

function keyToDate (key, { ascending = false } = {}) {
  const seconds = parseInt(key.slice(0, maxSecondsLength))
  const paddedMs = key.slice(maxSecondsLength, maxSecondsLength + 3)
  const realSeconds = (ascending ? seconds : (-1 * (seconds - maxTs))) - maxDateNowSeconds
  const ms = parseInt(`${realSeconds}${paddedMs}`, 10)
  return new Date(ms)
}

function keyToId (key) {
  const maxMsLength = 3
  return key.slice(maxSecondsLength + maxMsLength)
}

// const deta = Deta(process.env.DETA_COLLECTION_DATA_KEY)
const deta = {}

export {
  generateKey,
  keyToDate,
  keyToId
}
export default deta
