// The DSH plugin manager names a bundle from its own `locale/<language>.json`
// files, read through the package's export map. A missing file or a missing
// `meta.title` silently falls back to the npm package name, so this test pins
// the two languages the panel itself speaks.

import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const LANGUAGES = ['en', 'zh']

function metaOf(language) {
  const resolved = import.meta.resolve(`${pkg.name}/locale/${language}.json`)
  return JSON.parse(readFileSync(new URL(resolved), 'utf8')).meta
}

test('the plugin manager can read a localized name and description for both languages', () => {
  assert.equal(pkg.exports['./locale/*'], './locale/*', 'the locale folder must be exported for the resolver')

  const titles = new Set()
  const descriptions = new Set()
  for (const language of LANGUAGES) {
    const meta = metaOf(language)
    assert.equal(typeof meta.title, 'string', `${language}.json names the plugin`)
    assert.ok(meta.title.trim().length > 0, `${language}.json has a non-empty title`)
    assert.equal(typeof meta.description, 'string', `${language}.json describes the plugin`)
    assert.ok(meta.description.trim().length > 0, `${language}.json has a non-empty description`)
    titles.add(meta.title)
    descriptions.add(meta.description)
  }
  assert.equal(titles.size, LANGUAGES.length, 'each language names the plugin in its own words')
  assert.equal(descriptions.size, LANGUAGES.length, 'each language describes the plugin in its own words')

  // The list shows the title verbatim, in the current UI language, so both titles
  // carry the full package name: English is the name alone, Chinese keeps the
  // readable label in front of it (the format every other plugin row uses).
  assert.equal(metaOf('en').title, pkg.name, 'the English name is the full package name')
  assert.ok(metaOf('zh').title.endsWith(` · ${pkg.name}`), 'the Chinese title ends with the package name')
})

test('the published file list carries the locale folder', () => {
  assert.ok(pkg.files.includes('locale'), 'files must ship locale/')
})
