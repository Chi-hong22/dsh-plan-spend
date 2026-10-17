/**
 * Writes `client.js` from `client.body.js`.
 *
 * The rendering itself lives in `render-client.mjs`, shared with the drift test
 * that compares the committed bundle. Plain JavaScript with zero build-time
 * dependencies, so this script is the whole build step.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderClient } from './render-client.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const body = readFileSync(join(root, 'client.body.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const client = renderClient(body, pkg.name)
writeFileSync(join(root, 'client.js'), client)
console.log(`[dsh-plan-spend] wrote client.js (${client.length} bytes)`)
