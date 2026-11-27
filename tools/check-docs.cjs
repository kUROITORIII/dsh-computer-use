#!/usr/bin/env node
/**
 * Check every relative link and image in the published Markdown files.
 *
 *   node tools/check-docs.cjs
 *
 * 外链（http/https）、页内锚点（#xxx）、代码块里的内容一律跳过；`dev/` 不检查。
 * 退出码 1 = 有断链，方便放进发布前的检查清单（CI 也跑它）。
 */
const { readFileSync, existsSync, statSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const root = resolve(__dirname, '..')

/** Every Markdown file that ships: README at the root plus docs/*.md. */
function shippedDocs(dir, prefix, out) {
  for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`
    if (entry.isFile()) {
      if (/\.md$/i.test(entry.name)) out.push(relative)
    } else if (entry.isDirectory() && entry.name !== 'dev') {
      shippedDocs(join(dir, entry.name), relative, out)
    }
  }
  return out
}

const files = [
  'README.md',
  'LICENSE',
  ...shippedDocs(join(root, 'docs'), 'docs', []).filter((file) => file !== 'LICENSE'),
]

const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

let broken = 0
let checked = 0
for (const relative of files) {
  const path = join(root, relative)
  if (!existsSync(path)) {
    console.log(`MISSING FILE ${relative}`)
    broken += 1
    continue
  }
  const text = readFileSync(path, 'utf8')
  const prose = text.replace(/```[\s\S]*?```/g, '')
  for (const match of prose.matchAll(LINK)) {
    const target = match[1]
    if (/^(https?:|mailto:|#)/i.test(target)) continue
    const clean = target.split('#')[0]
    if (clean === '') continue
    checked += 1
    const absolute = resolve(dirname(path), clean)
    if (!existsSync(absolute)) {
      console.log(`BROKEN ${relative} -> ${target}`)
      broken += 1
    } else if (statSync(absolute).isDirectory()) {
      console.log(`DIR     ${relative} -> ${target}`)
      broken += 1
    }
  }
}

// locale 指向的 detail 页必须存在（插件详情页用它）
for (const locale of ['zh', 'en']) {
  const file = join(root, 'locale', `${locale}.json`)
  if (!existsSync(file)) { console.log(`MISSING ${file}`); broken += 1; continue }
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const detail = data?.meta?.detail
  if (typeof detail !== 'string' || !existsSync(join(root, detail))) {
    console.log(`BROKEN locale/${locale}.json meta.detail -> ${detail}`)
    broken += 1
  }
}

console.log(`\n${checked} relative links checked, ${broken} problem(s)`)
process.exit(broken === 0 ? 0 : 1)
