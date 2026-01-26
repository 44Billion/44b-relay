import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import { Readable } from 'node:stream'
import { buffer } from 'node:stream/consumers'

export const compressAsync = async (buf) => {
  const compressor = createZstdCompress({ level: 3 })
  const source = Readable.from([buf])
  source.pipe(compressor)
  return buffer(compressor)
}

export const decompressAsync = async (buf) => {
  const decompressor = createZstdDecompress()
  const source = Readable.from([buf])
  source.pipe(decompressor)
  return buffer(decompressor)
}
