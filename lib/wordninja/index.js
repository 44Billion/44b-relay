import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Original idea on how to split strings is from:
// http://stackoverflow.com/a/11642687/2449774
// Thanks Generic Human!
// Ported from https://github.com/timminator/wordninja-enhanced (Python)

const NO_SPACE_BEFORE_BASE = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '%', "'", '\u2019', 's', '»', '›', '-'])
const NO_SPACE_AFTER_BASE = new Set(['(', '[', '{', '«', '‹', '¡', '¿', '-', '$', '€', '£'])

const LANGUAGE_FILES = {
  en: 'en.txt.gz',
  de: 'de.txt.gz',
  fr: 'fr.txt.gz',
  es: 'es.txt.gz',
  it: 'it.txt.gz',
  pt: 'pt.txt.gz',
  nl: 'nl.txt.gz',
  pl: 'pl.txt.gz',
  sv: 'sv.txt.gz',
  ru: 'ru.txt.gz',
  tr: 'tr.txt.gz'
}

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_FILES)

/**
 * Splits, analyzes, and rejoins text based on real-world word frequencies
 * for a specified pre-defined language or a custom dictionary file.
 */
export class LanguageModel {
  /**
   * @param {object} [options]
   * @param {string} [options.language='en'] Language code ('en','de','fr','es','it','pt','nl','pl','sv','ru','tr') or 'custom'.
   * @param {string} [options.wordFile] Path to a gzipped word frequency file. Required when language is 'custom'.
   * @param {string[]} [options.addWords] Words to add to the dictionary.
   * @param {string[]} [options.blacklist] Words to remove from the dictionary.
   * @param {boolean} [options.addToTop=false] If true, added words are treated as most frequent.
   * @param {boolean} [options.overwrite=false] If true, replaces existing words with those in addWords.
   */
  constructor ({ language = 'en', wordFile = null, addWords = null, blacklist = null, addToTop = false, overwrite = false } = {}) {
    let words

    if (language === 'custom') {
      if (!wordFile) throw new Error("If language is 'custom', a valid 'wordFile' path must be provided.")
      words = gunzipSync(readFileSync(wordFile)).toString('utf-8').split(/\s+/).filter(Boolean)
    } else {
      const filename = LANGUAGE_FILES[language]
      if (!filename) throw new Error(`Language '${language}' not supported. Supported: ${SUPPORTED_LANGUAGES.join(', ')}, or use 'custom' with wordFile.`)
      const dictPath = join(__dirname, 'resources', filename)
      try {
        words = gunzipSync(readFileSync(dictPath)).toString('utf-8').split(/\s+/).filter(Boolean)
      } catch (err) {
        throw new Error(`Dictionary for language '${language}' not found. Run 'node lib/wordninja/build-dictionaries.js' to download dictionaries. (${err.message})`)
      }
    }

    if (blacklist?.length) {
      const blacklistSet = new Set(blacklist)
      words = words.filter(w => !blacklistSet.has(w))
    }

    if (addWords?.length) {
      let lowerAddWords = addWords.map(w => w.toLowerCase())
      if (overwrite) {
        const addSet = new Set(lowerAddWords)
        words = words.filter(w => !addSet.has(w))
      } else {
        const wordSet = new Set(words)
        lowerAddWords = lowerAddWords.filter(w => !wordSet.has(w))
      }
      words = addToTop ? [...lowerAddWords, ...words] : [...words, ...lowerAddWords]
    }

    const logVocabSize = Math.log(words.length)
    this._wordCost = new Map()
    for (let i = 0; i < words.length; i++) {
      this._wordCost.set(words[i], Math.log((i + 1) * logVocabSize))
    }
    this._maxWord = words.reduce((max, w) => Math.max(max, w.length), 0)

    this._noSpaceBefore = new Set(NO_SPACE_BEFORE_BASE)
    this._noSpaceAfter = new Set(NO_SPACE_AFTER_BASE)

    if (language === 'de') {
      ;['-', '%'].forEach(c => this._noSpaceBefore.delete(c))
      ;['-', '$', '€', '£'].forEach(c => this._noSpaceAfter.delete(c))
    } else if (language === 'fr') {
      ;[':', ';', '!', '?', '»', '%'].forEach(c => this._noSpaceBefore.delete(c))
      this._noSpaceAfter.delete('«')
    } else if (language === 'es') {
      this._noSpaceBefore.delete('%')
    }
  }

  /**
   * Uses dynamic programming to infer word boundaries in a string without spaces.
   * @param {string} s
   * @returns {string[]}
   */
  split (s) {
    const result = []
    for (const part of s.split(/(\s+)/)) {
      if (/^\s+$/.test(part)) {
        result.push(part)
      } else if (part) {
        result.push(...this._split(part))
      }
    }
    return result
  }

  /**
   * Find the best match for the first i characters, given the cost array.
   * Returns [minCost, wordLength].
   * @private
   */
  _bestMatch (s, cost, i) {
    const start = Math.max(0, i - this._maxWord)
    let minCost = Infinity
    let bestK = 0

    for (let k = 0; k < i - start; k++) {
      const c = cost[i - 1 - k]
      const word = s.slice(i - k - 1, i).toLowerCase()
      let wordCost = this._wordCost.get(word)
      if (wordCost === undefined) {
        // High but finite penalty for single unknown chars (allows continuation).
        // Infinite penalty for longer unknown words (forces splitting).
        wordCost = word.length === 1 ? 25 : Infinity
      }
      const total = c + wordCost
      if (total < minCost) {
        minCost = total
        bestK = k + 1
      }
    }

    return [minCost, bestK]
  }

  /** @private */
  _split (s) {
    // Build cost array.
    const cost = [0]
    for (let i = 1; i <= s.length; i++) {
      cost.push(this._bestMatch(s, cost, i)[0])
    }

    // Backtrack to recover minimal-cost split.
    const out = []
    let i = s.length
    while (i > 0) {
      const [, k] = this._bestMatch(s, cost, i)
      const token = s.slice(i - k, i)
      let newToken = true

      if (token !== "'") {
        if (out.length > 0) {
          const last = out[out.length - 1]
          // Re-attach split 's and adjacent digit sequences.
          if (last === "'s" || (/\d$/.test(token) && /^\d/.test(last))) {
            out[out.length - 1] = token + last
            newToken = false
          }
        }
      }

      if (newToken) out.push(token)
      i -= k
    }

    return out.reverse()
  }

  /** @private */
  _postProcessCandidate (split) {
    if (!split.length) return []
    const result = [split[0]]
    for (let i = 1; i < split.length; i++) {
      const token = split[i]
      const prev = result[result.length - 1]
      const shouldMerge =
        (token === "'s" && !prev.endsWith("'")) ||
        (token && prev && /\d$/.test(prev) && /^\d/.test(token))
      if (shouldMerge) result[result.length - 1] += token
      else result.push(token)
    }
    return result
  }

  /** @private */
  _beamSearchOnChunk (chunk, beamWidth) {
    const dp = Array.from({ length: chunk.length + 1 }, () => [])
    dp[0] = [{ split: [], cost: 0 }]

    for (let i = 1; i <= chunk.length; i++) {
      const candidatesForI = []
      for (let j = Math.max(0, i - this._maxWord); j < i; j++) {
        const word = chunk.slice(j, i)
        let wordCost = this._wordCost.get(word)
        if (wordCost === undefined) {
          wordCost = word.length === 1 ? 25 : Infinity
        }
        if (wordCost < 1e100) {
          for (const { split, cost } of dp[j]) {
            candidatesForI.push({ split: [...split, word], cost: cost + wordCost })
          }
        }
      }
      dp[i] = candidatesForI.sort((a, b) => a.cost - b.cost).slice(0, beamWidth)
    }

    return dp[chunk.length]
  }

  /**
   * Returns multiple candidate splits sorted by cost (best first).
   * @param {string} s
   * @param {number} [topN=10]
   * @returns {string[][]}
   */
  candidates (s, topN = 10) {
    s = s.toLowerCase()
    const beamWidth = Math.max(topN, 10)
    let beam = [{ split: [], cost: 0 }]

    for (const chunk of s.split(/(\s+)/).filter(Boolean)) {
      const newBeam = []
      if (/^\s+$/.test(chunk)) {
        for (const { split, cost } of beam) {
          newBeam.push({ split: [...split, chunk], cost })
        }
      } else {
        let chunkCandidates = this._beamSearchOnChunk(chunk, beamWidth)
        if (!chunkCandidates.length) {
          chunkCandidates = [{ split: [chunk], cost: Infinity }]
        }
        for (const { split: prevSplit, cost: prevCost } of beam) {
          for (const { split: chunkSplit, cost: chunkCost } of chunkCandidates) {
            newBeam.push({ split: [...prevSplit, ...chunkSplit], cost: prevCost + chunkCost })
          }
        }
      }
      beam = newBeam.sort((a, b) => a.cost - b.cost).slice(0, beamWidth)
    }

    return beam
      .slice(0, topN)
      .map(({ split }) => this._postProcessCandidate(split))
  }

  /**
   * Splits text into words and rejoins with typographically correct spacing.
   * @param {string} text
   * @returns {string}
   */
  rejoin (text) {
    const tokens = this.split(text)
    if (!tokens.length) return ''

    const parts = []
    let inQuotes = false

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      const isOpeningQuote = token === '"' && !inQuotes

      parts.push(token)

      if (token === '"') inQuotes = !inQuotes

      if (i < tokens.length - 1) {
        const next = tokens[i + 1]
        let addSpace = true

        if (isOpeningQuote) {
          addSpace = false
        } else if (next === '"' && inQuotes) {
          addSpace = false
        } else if (this._noSpaceAfter.has(token) || this._noSpaceBefore.has(next)) {
          addSpace = false
        } else if (/^\s+$/.test(token) || /^\s+$/.test(next)) {
          addSpace = false
        }

        if (addSpace) parts.push(' ')
      }
    }

    return parts.join('')
  }
}

const defaultModel = new LanguageModel({ language: 'en' })

/** Splits a string using the default English model. */
export const split = s => defaultModel.split(s)

/** Returns candidate splits using the default English model. */
export const candidates = (s, topN = 10) => defaultModel.candidates(s, topN)

/** Rejoins a string using the default English model's spacing rules. */
export const rejoin = s => defaultModel.rejoin(s)
