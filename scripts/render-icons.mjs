/**
 * Renders extension/icons/icon.svg to the PNG sizes the browsers and
 * stores want. Run after editing the SVG: npm run icons
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const root = resolve(import.meta.dirname, '..')
const svg = readFileSync(resolve(root, 'extension/icons/icon.svg'), 'utf8')

const targets = [
  ...[16, 32, 48, 96, 128].map((size) => ({ size, out: `extension/icons/icon${size}.png` })),
  { size: 512, out: 'site/assets/icon-512.png' },
  { size: 180, out: 'site/assets/apple-touch-icon.png' },
]

for (const { size, out } of targets) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  const path = resolve(root, out)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, png)
  console.log(`OK: ${out}`)
}
