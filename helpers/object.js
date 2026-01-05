const pick = (json, ...keys) => {
  keys = [].concat(...keys)

  return keys.reduce((memo, key) => {
    if (json[key] !== undefined) ({ [key]: memo[key] } = json)
    return memo
  }, {})
}

const omit = (json, ...keys) => {
  keys = [].concat(...keys)

  return keys.reduce((memo, key) => {
    delete memo[key]
    return memo
  }, { ...json })
}

export {
  pick,
  omit
}
