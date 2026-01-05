const urlRegExp = /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-z]{2,63}\b([-a-zA-Z0-9@:%_+.~#?&/=]*)$/i
const hostnameRegExp = /^[A-Za-z0-9._-]{1,256}\.[a-z]{2,63}$/
const imageDataUrlRegExp =
  /^data:(?<mime>image\/(?:apng|avif|bmp|gif|ico|jpeg|png|svg\+xml|webp|x-icon))(?:(?:;(?:charset=(?:utf-8|us-ascii|iso-8859-7)|utf8))?,.+|;base64,[A-Za-z0-9+/=]+)$/i

export {
  hostnameRegExp,
  urlRegExp,
  imageDataUrlRegExp
}
