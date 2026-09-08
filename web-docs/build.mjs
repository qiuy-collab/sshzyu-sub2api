import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const sectionLabels = new Map([
  ['1-quick-start', '快速开始'], ['2-客户端接入', '客户端接入'],
  ['3-错误码', '错误码'], ['4-联系方式', '联系方式'],
])

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function unescapeHtml(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'",
  })[entity])
}

/** Retain the original renderer's IDs so existing documentation links keep working. */
export function headingSlug(text, lineIndex = 0) {
  return text.toLowerCase().replace(/[^\w一-鿿]+/g, '-').replace(/^-|-$/g, '') || `section-${lineIndex}`
}

/** Markdown is content, never HTML or an executable URL. Preserve valid URLs verbatim. */
export function safeUrl(value) {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value) || value.startsWith('//')) return null
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    if (!/^https?:\/\//i.test(value)) return null
    try {
      const url = new URL(value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    } catch { return null }
  }
  return value
}

function emphasis(text) {
  return text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
}

/** Based on the existing renderer, with escaped HTML and URL validation. */
export function inlineMarkdown(value) {
  const tokens = []
  const stash = html => { tokens.push(html); return `\u0000${tokens.length - 1}\u0000` }
  let text = escapeHtml(String(value).replace(/\u0000/g, '\ufffd'))
  text = text.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${code}</code>`))
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, encodedUrl) => {
    const url = safeUrl(unescapeHtml(encodedUrl))
    return stash(url ? `<img src="${escapeHtml(url)}" alt="${alt}" loading="lazy">` : alt)
  })
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, encodedUrl) => {
    const url = safeUrl(unescapeHtml(encodedUrl))
    return stash(url ? `<a href="${escapeHtml(url)}">${emphasis(label)}</a>` : emphasis(label))
  })
  const restore = html => html.replace(/\u0000(\d+)\u0000/g, (_, index) => restore(tokens[Number(index)]))
  return restore(emphasis(text))
}

function imagesInLine(line) {
  const expression = /!\[([^\]]*)\]\(([^)\s]+)\)/g
  const images = [...line.matchAll(expression)].map(match => ({ alt: match[1], url: match[2] }))
  return images.length && !line.replace(expression, '').trim() ? images : null
}

function renderGallery(images) {
  return `<div class="doc-gallery">${images.map(({ alt, url }) => {
    const source = safeUrl(url)
    const classes = alt === '交流群' ? 'doc-shot doc-contact-shot' : 'doc-shot'
    const picture = source
      ? `<button class="image-zoom" type="button" data-image-src="${escapeHtml(source)}" aria-label="${escapeHtml(`放大查看：${alt || '文档图片'}`)}"><img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}" loading="lazy"></button>`
      : ''
    return `<figure class="${classes}">${picture}<figcaption>${escapeHtml(alt)}</figcaption></figure>`
  }).join('')}</div>`
}

function renderBlocks(markdown, wrapSections) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const html = []
  let i = 0
  let sectionOpen = false
  let sectionCount = 0
  let nearestHeading = '文档表格'
  const isBlank = line => /^\s*$/.test(line)
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) { i++; continue }
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/)
    if (fence) {
      const language = fence[1] || 'text'
      const code = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++ }
      if (i < lines.length) i++
      html.push(`<div class="code-wrap"><div class="code-toolbar"><span class="code-language">${escapeHtml(language)}</span><button class="copy" type="button">复制</button></div><pre><code class="language-${escapeHtml(language)}">${escapeHtml(code.join('\n'))}</code></pre></div>`)
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].trim()
      const id = headingSlug(text, i)
      if (level === 1 && wrapSections) { i++; continue }
      nearestHeading = text.replace(/[*_`]/g, '')
      if (level === 2 && wrapSections) {
        if (sectionOpen) html.push('</section>')
        sectionOpen = true
        sectionCount++
        const number = String(text.match(/^(\d+)[.)]\s+/)?.[1] || sectionCount).padStart(2, '0')
        const label = sectionLabels.get(id) || text.replace(/^\d+[.)]\s+/, '')
        html.push(`<section class="doc-section"><h2 id="${escapeHtml(id)}" aria-label="${escapeHtml(text)}"><span class="section-number" aria-hidden="true">${number}</span><span>${inlineMarkdown(label)}</span></h2>`)
      } else {
        html.push(`<h${level} id="${escapeHtml(id)}">${inlineMarkdown(text)}</h${level}>`)
      }
      i++
      continue
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { html.push('<hr>'); i++; continue }
    if (/^\s*>/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      html.push(`<blockquote>${renderBlocks(quote.join('\n'), false)}</blockquote>`)
      continue
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
      const headers = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++ }
      html.push(`<div class="doc-table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(nearestHeading)}"><table><thead><tr>${headers.map(cell => `<th scope="col">${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, index) => `<td>${inlineMarkdown(row[index] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/)
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/)
    if (unordered || ordered) {
      const tag = unordered ? 'ul' : 'ol'
      const items = []
      while (i < lines.length) {
        const match = lines[i].match(unordered ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/)
        if (!match) break
        items.push(ordered ? `<li><div class="step-content">${inlineMarkdown(match[1])}</div></li>` : `<li>${inlineMarkdown(match[1])}</li>`)
        i++
      }
      const attributes = ordered ? ` class="step-list"${ordered[1] === '1' ? '' : ` start="${Number(ordered[1])}"`}` : ''
      html.push(`<${tag}${attributes}>${items.join('')}</${tag}>`)
      continue
    }
    if (imagesInLine(line)) {
      const images = []
      while (i < lines.length) {
        const found = imagesInLine(lines[i])
        if (!found) break
        images.push(...found)
        i++
        while (i < lines.length && isBlank(lines[i])) i++
      }
      html.push(renderGallery(images))
      continue
    }
    const paragraph = [line]
    i++
    while (i < lines.length && !isBlank(lines[i]) && !/^\s*(#{1,6})\s+/.test(lines[i])
      && !/^\s*```/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])
      && !/^\s*\|/.test(lines[i]) && !imagesInLine(lines[i])) { paragraph.push(lines[i]); i++ }
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`)
  }
  if (sectionOpen) html.push('</section>')
  return html.join('\n')
}

export function renderMarkdown(markdown) {
  return renderBlocks(String(markdown), true)
}

export function assetHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

/** Local static build only; no network, runtime execution, or production operations. */
export async function buildDocs({ sourceDir = sourceDirectory, outDir = join(sourceDir, 'dist'),
  logoPath = resolve(sourceDirectory, '../frontend/src/assets/sshzyu-mark.svg') } = {}) {
  const [template, markdown, css, script, logo] = await Promise.all([
    readFile(join(sourceDir, 'template.html'), 'utf8'), readFile(join(sourceDir, 'content.md'), 'utf8'),
    readFile(join(sourceDir, 'styles.css')), readFile(join(sourceDir, 'docs.js')), readFile(logoPath),
  ])
  for (const token of ['CONTENT', 'STYLE_URL', 'SCRIPT_URL', 'LOGO_URL']) {
    if (!template.includes(`{{${token}}}`)) throw new Error(`Template is missing {{${token}}}`)
  }
  if (template.split('{{CONTENT}}').length !== 2) throw new Error('Template must contain {{CONTENT}} exactly once')
  const assets = {
    style: `assets/docs.${assetHash(css)}.css`, script: `assets/docs.${assetHash(script)}.js`,
    logo: `assets/sshzyu-mark.${assetHash(logo)}.svg`,
  }
  const substitutions = {
    CONTENT: renderMarkdown(markdown), STYLE_URL: assets.style, SCRIPT_URL: assets.script, LOGO_URL: assets.logo,
  }
  // One template pass prevents document examples from being interpreted as template directives.
  const html = template.replace(/\{\{(CONTENT|STYLE_URL|SCRIPT_URL|LOGO_URL)\}\}/g, (_, name) => substitutions[name])
  await mkdir(join(outDir, 'assets'), { recursive: true })
  await Promise.all([
    writeFile(join(outDir, assets.style), css), writeFile(join(outDir, assets.script), script),
    writeFile(join(outDir, assets.logo), logo),
  ])
  await writeFile(join(outDir, 'index.html'), html, 'utf8')
  return { outDir, index: join(outDir, 'index.html'), assets }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildDocs().then(result => { console.log(JSON.stringify(result, null, 2)) })
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
