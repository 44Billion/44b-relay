#!/usr/bin/env node
/**
 * Downloads and prepares dictionary files for lib/wordninja.
 *
 * Sources:
 *   - en, de, fr, es, it, pt: timminator/wordninja-enhanced (GitHub release tarball)
 *     High-quality frequency lists: ~680k–1.3M words per language.
 *   - nl, pl, sv, ru, tr: hermitdave/FrequencyWords (OpenSubtitles 2018)
 *     50k most-frequent words per language. License: CC-BY-SA-4.0.
 *
 * Run once:  node lib/wordninja/build-dictionaries.js
 */

import { writeFileSync, mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { gunzipSync, gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = join(__dirname, 'resources')

mkdirSync(RESOURCES_DIR, { recursive: true })

async function download (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

// ---------------------------------------------------------------------------
// en, de, fr, es, it, pt – from wordninja-enhanced release tarball
// (files are Git LFS tracked and not directly downloadable via raw URLs)
// ---------------------------------------------------------------------------
const WORDNINJA_LANGS = ['en', 'de', 'fr', 'es', 'it', 'pt']
const TARBALL_URL = 'https://api.github.com/repos/timminator/wordninja-enhanced/tarball/v3.1.1'

process.stdout.write('Downloading wordninja-enhanced release tarball... ')
const tarData = await download(TARBALL_URL)
console.log(`${(tarData.length / 1e6).toFixed(1)} MB`)

const tmpDir = mkdtempSync(join(tmpdir(), 'wordninja-'))
const tarPath = join(tmpDir, 'release.tar.gz')
writeFileSync(tarPath, tarData)
execSync(`tar -xzf ${tarPath} -C ${tmpDir} --wildcards '*/resources/*.gz'`)

const extractedDir = (await import('node:fs')).readdirSync(tmpDir).find(d => d.startsWith('timminator-'))
const srcDir = join(tmpDir, extractedDir, 'wordninja_enhanced', 'resources')

for (const lang of WORDNINJA_LANGS) {
  process.stdout.write(`Processing ${lang}... `)
  const data = readFileSync(join(srcDir, `${lang}_dict.txt.gz`))
  const words = gunzipSync(data).toString('utf-8').split(/\s+/).filter(Boolean)
  writeFileSync(join(RESOURCES_DIR, `${lang}.txt.gz`), gzipSync(words.join('\n'), { level: 9 }))
  console.log(`${words.length.toLocaleString()} words`)
}

rmSync(tmpDir, { recursive: true })

// ---------------------------------------------------------------------------
// nl, pl, sv, ru, tr – from Hermit Dave's FrequencyWords (OpenSubtitles 2018)
// Format: "word count" per line, sorted by frequency descending.
// ---------------------------------------------------------------------------
const HERMIT_DAVE_LANGS = {
  nl: 'nl', // Dutch
  pl: 'pl', // Polish
  sv: 'sv', // Swedish
  ru: 'ru', // Russian
  tr: 'tr'  // Turkish
}

for (const [lang, code] of Object.entries(HERMIT_DAVE_LANGS)) {
  const url = `https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${code}/${code}_50k.txt`
  process.stdout.write(`Downloading ${lang} (FrequencyWords)... `)
  const data = await download(url)
  // Strip frequency counts; keep only the word (first field per line)
  const words = data.toString('utf-8')
    .split('\n')
    .map(line => line.split(' ')[0].trim())
    .filter(Boolean)
  writeFileSync(join(RESOURCES_DIR, `${lang}.txt.gz`), gzipSync(words.join('\n'), { level: 9 }))
  console.log(`${words.length.toLocaleString()} words`)
}

console.log(`\nDictionaries saved to ${RESOURCES_DIR}`)
