/**
 * Rasterize branded SVGs to public/og.png and public/apple-touch-icon.png.
 * Run via: npm run build:og (also runs automatically before production build).
 */
import sharp from 'sharp'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const ogSvg = readFileSync(join(__dirname, 'og-brand.svg'))

await sharp(ogSvg).png({ compressionLevel: 9 }).toFile(join(root, 'public/og.png'))

const iconSvg = readFileSync(join(root, 'public/icon.svg'))
await sharp(iconSvg).resize(180, 180).png({ compressionLevel: 9 }).toFile(join(root, 'public/apple-touch-icon.png'))

console.log('Wrote public/og.png and public/apple-touch-icon.png')
