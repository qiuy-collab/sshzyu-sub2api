import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { assetHash, buildDocs, escapeHtml, headingSlug, inlineMarkdown, renderMarkdown, safeUrl } from '../build.mjs'

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceBytes = await readFile(join(docsRoot, 'content.md'))
const source = sourceBytes.toString('utf8')
const rendered = renderMarkdown(source)
const originalHash = '6d65a65d607e466336f7b6664ae0d85569194fc937039c3345f87a7d1c393c15'
const digest = value => createHash('sha256').update(value).digest('hex')
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'",
})[entity])
const textContent = html => decode(html.replace(/<[^>]+>/g, ''))
const sourcePlainText = markdown => markdown.replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1')

test('the source is the exact original byte sequence, including final line endings', async () => {
  assert.equal(digest(sourceBytes), originalHash)
  const originalPath = resolve(docsRoot, '../../output/docs-original/content.md')
  if (existsSync(originalPath)) assert.deepEqual(sourceBytes, await readFile(originalPath))
})

test('all four existing anchors survive while headings receive aligned number/title spans', () => {
  const headings = [...source.matchAll(/^## (.+)$/gm)].map(match => match[1].trim())
  assert.deepEqual(headings.map(heading => headingSlug(heading)), ['1-quick-start', '2-客户端接入', '3-错误码', '4-联系方式'])
  assert.equal((rendered.match(/<section class="doc-section">/g) || []).length, 4)
  assert.equal((rendered.match(/<\/section>/g) || []).length, 4)
  assert.equal((rendered.match(/<h1\b/g) || []).length, 0)
  const titles = ['快速开始', '客户端接入', '错误码', '联系方式']
  headings.forEach((heading, index) => {
    assert.ok(rendered.includes(`<h2 id="${headingSlug(heading)}" aria-label="${heading}"><span class="section-number" aria-hidden="true">0${index + 1}</span><span>${titles[index]}</span></h2>`))
  })
  assert.equal(headingSlug('!!!', 12), 'section-12')
  for (const match of source.matchAll(/^### (.+)$/gm)) {
    assert.ok(rendered.includes(`<h3 id="${headingSlug(match[1].trim())}">`))
    assert.ok(rendered.includes(inlineMarkdown(match[1].trim())))
  }
})

test('every complete code example is byte-for-byte equivalent after HTML decoding', () => {
  const normalized = source.replace(/\r\n?/g, '\n')
  const blocks = [...normalized.matchAll(/^```([^\n]*)\n([\s\S]*?)\n```/gm)]
  const output = [...rendered.matchAll(/<div class="code-wrap"><div class="code-toolbar"><span class="code-language">([^<]+)<\/span><button class="copy" type="button">复制<\/button><\/div><pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre><\/div>/g)]
  assert.equal(blocks.length, 6)
  assert.equal(output.length, blocks.length)
  blocks.forEach((block, index) => {
    assert.equal(output[index][1], block[1])
    assert.equal(output[index][2], block[1])
    assert.equal(decode(output[index][3]), block[2])
  })
})

test('all table headers/cells and ordered steps retain their text and order', () => {
  const rows = source.split(/\r?\n/).filter(line => /^\s*\|/.test(line) && !/^\s*\|\s*:?-{3,}/.test(line))
  const cells = rows.flatMap(row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => sourcePlainText(cell.trim())))
  const outputCells = [...rendered.matchAll(/<(?:th|td)(?: scope="col")?>([\s\S]*?)<\/(?:th|td)>/g)].map(match => textContent(match[1]))
  assert.equal(cells.length, 142)
  assert.deepEqual(outputCells, cells)
  const steps = [...source.matchAll(/^\d+[.)]\s+(.+)$/gm)].map(match => sourcePlainText(match[1].trim()))
  const outputSteps = [...rendered.matchAll(/<li><div class="step-content">([\s\S]*?)<\/div><\/li>/g)].map(match => textContent(match[1]))
  assert.equal(steps.length, 22)
  assert.deepEqual(outputSteps, steps)
  assert.equal((rendered.match(/<ol class="step-list">/g) || []).length, 5)
  assert.equal((rendered.match(/<div class="doc-table-wrap" tabindex="0" role="region" aria-label="[^"]+">/g) || []).length, 7)
  assert.ok(rendered.includes('aria-label="CODE / DESCRIPTION"><table>'))
})

test('every original image path/alt and link remains intact, with grouped zoomable screenshots', () => {
  const images = [...source.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map(match => ({ alt: match[1], url: match[2] }))
  const outputImages = [...rendered.matchAll(/<img src="([^"]+)" alt="([^"]*)" loading="lazy">/g)].map(match => ({ alt: decode(match[2]), url: decode(match[1]) }))
  assert.equal(images.length, 7)
  assert.deepEqual(outputImages, images)
  const gallerySizes = [...rendered.matchAll(/<div class="doc-gallery">([\s\S]*?)<\/div>/g)].map(match => (match[1].match(/<figure /g) || []).length)
  assert.deepEqual(gallerySizes, [2, 2, 2, 1])
  assert.equal((rendered.match(/class="image-zoom" type="button" data-image-src=/g) || []).length, 7)
  assert.ok(rendered.includes('<figure class="doc-shot doc-contact-shot">'))
  assert.deepEqual([...rendered.matchAll(/<figcaption>([^<]*)<\/figcaption>/g)].map(match => decode(match[1])), images.map(image => image.alt))
  const bodySource = source.replace(/^# .+\r?\n/m, '')
  const links = [...bodySource.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)].map(match => match[2])
  assert.deepEqual([...rendered.matchAll(/<a href="([^"]+)">/g)].map(match => decode(match[1])), links)
})

test('all explanatory paragraphs and notices survive, including API precautions', () => {
  let inFence = false
  const paragraphs = []
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^```/.test(line)) { inFence = !inFence; continue }
    if (inFence || !line.trim() || /^(?:#{1,6}\s|\||\d+[.)]\s|!\[)/.test(line)) continue
    paragraphs.push(sourcePlainText(line.replace(/^>\s?/, '').trim()))
  }
  assert.ok(paragraphs.length >= 20)
  const plainOutput = textContent(rendered)
  for (const paragraph of paragraphs) assert.ok(plainOutput.includes(paragraph), `Missing source paragraph: ${paragraph}`)
  assert.equal((rendered.match(/<blockquote>/g) || []).length, 2)
})

test('raw HTML and active URLs are escaped/rejected while safe relative and HTTP links survive', () => {
  const sample = '## 1. Example\n\n<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>\n\n'
    + '[unsafe](javascript:alert(1)) [case](JaVaScRiPt:boom) [data](data:text/html,x) ![bad](javascript:boom)\n\n'
    + '[relative](../keys?q=1&x=2) [anchor](#2-客户端接入) [site](https://sshzyu.com/keys)\n\n'
    + '> Preserve **strong**, _emphasis_, and `literal_*_code`.\n\n- An unordered item\n\n'
    + '```html\n</code><script>unsafe()</script>\n```'
  const html = renderMarkdown(sample)
  assert.ok(!/<script\b|<img\b|\b(?:href|src)="(?:javascript|data):/i.test(html))
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'))
  assert.ok(html.includes('<a href="../keys?q=1&amp;x=2">relative</a>'))
  assert.ok(html.includes('<a href="#2-客户端接入">anchor</a>'))
  assert.ok(html.includes('<blockquote><p>Preserve <strong>strong</strong>, <em>emphasis</em>, and <code>literal_*_code</code>.</p></blockquote>'))
  assert.ok(html.includes('<ul><li>An unordered item</li></ul>'))
  assert.ok(html.includes('&lt;/code&gt;&lt;script&gt;unsafe()&lt;/script&gt;'))
  for (const url of ['javascript:boom', 'data:image/svg+xml,x', 'vbscript:x', '//example.com', '\\example.com', 'java\nscript:boom']) assert.equal(safeUrl(url), null)
  for (const url of ['/keys', 'iamge/交流群.jpg', 'http://sshzyu.com', 'https://sshzyu.com/v1', '#1-quick-start']) assert.equal(safeUrl(url), url)
  assert.equal(inlineMarkdown('[A `code` value](/keys)'), '<a href="/keys">A <code>code</code> value</a>')
})

async function temporaryBuild(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sshzyu-docs-test-'))
  t.after(async () => {
    const absolute = resolve(directory)
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && dirname(absolute) === resolve(tmpdir()))
    assert.ok(absolute.split(sep).at(-1).startsWith('sshzyu-docs-test-'))
    await rm(absolute, { recursive: true, force: true })
  })
  return directory
}

test('build uses content hashes, exact asset bytes, one-pass placeholders, and deterministic output', async t => {
  const directory = await temporaryBuild(t)
  const logoPath = resolve(docsRoot, '../frontend/src/assets/sshzyu-mark.svg')
  const css = Buffer.from('body { color: #1d1d1f; }\r\n')
  const script = Buffer.from('document.documentElement.dataset.docs = "ready";\n')
  const logo = await readFile(logoPath)
  const template = '<!doctype html><link rel="stylesheet" href="{{STYLE_URL}}"><link rel="icon" href="{{LOGO_URL}}"><img src="{{LOGO_URL}}"><main>{{CONTENT}}</main><script src="{{SCRIPT_URL}}" defer></script>'
  await Promise.all([
    writeFile(join(directory, 'template.html'), template), writeFile(join(directory, 'content.md'), '# Ignored title\n\n`{{SCRIPT_URL}}`'),
    writeFile(join(directory, 'styles.css'), css), writeFile(join(directory, 'docs.js'), script),
  ])
  const result = await buildDocs({ sourceDir: directory, logoPath })
  assert.equal(result.assets.style, `assets/docs.${digest(css).slice(0, 12)}.css`)
  assert.equal(result.assets.script, `assets/docs.${digest(script).slice(0, 12)}.js`)
  assert.equal(result.assets.logo, `assets/sshzyu-mark.${digest(logo).slice(0, 12)}.svg`)
  const html = await readFile(result.index, 'utf8')
  assert.ok(html.includes('<main><p><code>{{SCRIPT_URL}}</code></p></main>'))
  assert.ok(!html.includes('{{CONTENT}}') && !html.includes('{{STYLE_URL}}') && !html.includes('{{LOGO_URL}}'))
  assert.ok(html.includes(`<script src="${result.assets.script}" defer>`))
  assert.equal((html.match(new RegExp(result.assets.logo.replaceAll('.', '\\.'), 'g')) || []).length, 2)
  for (const [kind, content] of [['style', css], ['script', script], ['logo', logo]]) {
    assert.deepEqual(await readFile(join(result.outDir, result.assets[kind])), content)
  }
  assert.equal(assetHash(css).length, 12)
  assert.equal((await readdir(join(result.outDir, 'assets'))).length, 3)
  await buildDocs({ sourceDir: directory, logoPath })
  assert.equal(await readFile(result.index, 'utf8'), html)
  const newCss = Buffer.from('body { color: blue; }')
  await writeFile(join(directory, 'styles.css'), newCss)
  const rebuilt = await buildDocs({ sourceDir: directory, logoPath })
  assert.notEqual(rebuilt.assets.style, result.assets.style)
  assert.equal(rebuilt.assets.script, result.assets.script)
  assert.deepEqual(await readFile(join(result.outDir, result.assets.style)), css)
})

test('a missing required template slot fails before writing any build output', async t => {
  const directory = await temporaryBuild(t)
  await Promise.all([
    writeFile(join(directory, 'template.html'), '{{CONTENT}}{{STYLE_URL}}{{SCRIPT_URL}}'),
    writeFile(join(directory, 'content.md'), 'A body'), writeFile(join(directory, 'styles.css'), ''), writeFile(join(directory, 'docs.js'), ''),
  ])
  await assert.rejects(buildDocs({ sourceDir: directory }), /missing \{\{LOGO_URL\}\}/)
  assert.equal(existsSync(join(directory, 'dist')), false)
  // An explicit empty output directory is not populated on a malformed template, either.
  await mkdir(join(directory, 'empty'))
  await assert.rejects(buildDocs({ sourceDir: directory, outDir: join(directory, 'empty') }), /missing/)
  assert.deepEqual(await readdir(join(directory, 'empty')), [])
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;')
})
