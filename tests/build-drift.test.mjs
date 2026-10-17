/**
 * `client.js` is committed and generated; nothing at runtime loads the body. A
 * forgotten rebuild would ship stale client code while every behaviour test
 * stayed green, so the committed file has to equal a fresh render.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderClient } from '../scripts/render-client.mjs'

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

// A checkout on Windows may hand back CRLF while the render is always LF; only
// content drift matters here, so line endings are compared normalized.
const normalizeEol = (text) => text.replace(/\r\n/g, '\n')

test('client.js is exactly the render of client.body.js', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(normalizeEol(read('client.js')), normalizeEol(renderClient(read('client.body.js'), pkg.name)))
})
