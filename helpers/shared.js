function getType (obj) { return Object.prototype.toString.call(obj).match(/\[object (\w+)\]/)[1].replace(/./, m => m.toLowerCase()) }
function isType (obj, typeName) { return getType(obj) === typeName }

export {
  isType
}
