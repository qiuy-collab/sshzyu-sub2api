import { describe, expect, it, vi } from 'vitest'
import {
  canConnectNodes, connectNodes, createStudioDocument, createStudioNode, exportStudioDocument,
  IMAGE_STUDIO_LIMITS, importStudioDocument, normalizeStudioImageUrl, removeStudioNode,
  resolveGenerationInputs, sanitizeStudioDocument, sanitizeStudioImageRef,
  type ImageStudioAssetRef, type ImageStudioDocument,
} from '../imageStudioGraph'

const asset = (name: string): ImageStudioAssetRef => ({ id: 'image-' + name, kind: 'asset', assetId: 'asset-' + name, mimeType: 'image/png' })
function board() {
  const document = createStudioDocument()
  const text = createStudioNode('text', { x: -40, y: 12 }, { text: '上游提示' })
  const reference = createStudioNode('reference', { x: 0, y: 100 }, { images: [asset('one')] })
  const generate = createStudioNode('generate', { x: 200, y: 12 }, { prompt: '基础提示' })
  document.nodes = [text, reference, generate]
  return { document, text, reference, generate }
}

describe('imageStudioGraph workflow', () => {
  it('creates editable defaults without generation state or credentials', () => {
    expect(createStudioDocument()).toMatchObject({ id: 'default', title: '未命名画布', schemaVersion: 1, nodes: [], edges: [] })
    expect(createStudioNode('generate', { x: 1, y: 2 }, { prompt: '修改提示' }, '生成')).toMatchObject({
      title: '生成', data: { prompt: '修改提示', referenceImages: [], outputCount: 1 }, position: { x: 1, y: 2 },
    })
  })

  it('merges direct inputs in stable order, deduplicating text and asset identities', () => {
    const { document, text, reference, generate } = board()
    generate.data.referenceImages = [{ ...asset('one'), id: 'same-image-new-id' }]
    const duplicateText = createStudioNode('text', { x: 0, y: 0 }, { text: '基础提示' })
    const result = createStudioNode('result', { x: 0, y: 0 }, { images: [asset('two')] })
    document.nodes.push(duplicateText, result)
    let connected = connectNodes(document, text.id, generate.id)
    connected = connectNodes(connected, reference.id, generate.id)
    connected = connectNodes(connected, duplicateText.id, generate.id)
    connected = connectNodes(connected, result.id, generate.id)
    expect(resolveGenerationInputs(connected, generate.id)).toEqual({
      prompt: '基础提示\n\n上游提示', images: [generate.data.referenceImages[0], asset('two')],
      sourceNodeIds: [text.id, reference.id, duplicateText.id, result.id],
    })
    expect(document.edges).toEqual([])
    expect(generate.data.prompt).toBe('基础提示')
  })

  it('rejects self, duplicate, missing and incompatible directional connections', () => {
    const { document, text, reference, generate } = board()
    expect(canConnectNodes(document, text.id, text.id)).toEqual({ ok: false, reason: 'SELF_CONNECTION' })
    expect(canConnectNodes(document, 'missing', generate.id)).toEqual({ ok: false, reason: 'MISSING_NODE' })
    expect(canConnectNodes(document, text.id, reference.id)).toEqual({ ok: false, reason: 'INCOMPATIBLE_CONNECTION' })
    const connected = connectNodes(document, text.id, generate.id)
    expect(canConnectNodes(connected, text.id, generate.id)).toEqual({ ok: false, reason: 'DUPLICATE_CONNECTION' })
    expect(canConnectNodes(connected, generate.id, text.id)).toEqual({ ok: false, reason: 'INCOMPATIBLE_CONNECTION' })
  })

  it('includes implicit generation-to-result relationships when rejecting cycles', () => {
    const { document, generate: first } = board()
    const second = createStudioNode('generate', { x: 500, y: 0 })
    const firstResult = createStudioNode('result', { x: 300, y: 0 }, { images: [asset('one')], generateNodeId: first.id })
    const secondResult = createStudioNode('result', { x: 700, y: 0 }, { images: [asset('two')], generateNodeId: second.id })
    document.nodes.push(second, firstResult, secondResult)
    expect(canConnectNodes(document, firstResult.id, first.id)).toEqual({ ok: false, reason: 'CYCLE' })
    const chain = connectNodes(document, firstResult.id, second.id)
    expect(canConnectNodes(chain, secondResult.id, first.id)).toEqual({ ok: false, reason: 'CYCLE' })
    expect(() => sanitizeStudioDocument({ ...chain, edges: [...chain.edges,
      { id: 'cycle-edge', source: secondResult.id, target: first.id }] })).toThrowError(expect.objectContaining({ code: 'CYCLE' }))
  })

  it('limits combined references to ten and checks inputs again at execution time', () => {
    const { document, reference, generate } = board()
    generate.data.referenceImages = Array.from({ length: 10 }, (_, index) => asset(String(index)))
    expect(canConnectNodes(document, reference.id, generate.id)).toEqual({ ok: false, reason: 'IMAGE_LIMIT' })
    reference.data.images = [asset('0')]
    const linked = connectNodes(document, reference.id, generate.id)
    expect(resolveGenerationInputs(linked, generate.id).images).toHaveLength(10)
    reference.data.images = []
    expect(() => resolveGenerationInputs(linked, generate.id)).toThrowError(expect.objectContaining({ code: 'MISSING_IMAGE' }))
    reference.data.images = [asset('additional')]
    expect(() => resolveGenerationInputs(linked, generate.id)).toThrowError(expect.objectContaining({ code: 'IMAGE_LIMIT' }))
  })

  it('removes a generator without deleting results and detaches their provenance', () => {
    const { document, text, generate } = board()
    const result = createStudioNode('result', { x: 10, y: 10 }, { images: [asset('one')], generateNodeId: generate.id })
    document.nodes.push(result)
    const updated = removeStudioNode(connectNodes(document, text.id, generate.id), generate.id)
    expect(updated.edges).toEqual([])
    expect(updated.nodes.find(node => node.id === result.id)).toMatchObject({ data: { images: [asset('one')] } })
    expect((updated.nodes.find(node => node.id === result.id)!.data as Record<string, unknown>).generateNodeId).toBeUndefined()
    expect(result.data.generateNodeId).toBe(generate.id)
    expect(() => sanitizeStudioDocument(updated)).not.toThrow()
  })
})

describe('imageStudioGraph import boundary', () => {
  it('round-trips schema data and strips unknown credentials and execution state', () => {
    const { document, text, generate } = board()
    const dirty = { ...connectNodes(document, text.id, generate.id), apiKey: 'SECRET_KEY', token: 'SECRET_TOKEN' }
    Object.assign(dirty.nodes[2].data, { status: 'running', authorization: 'SECRET_AUTH' })
    const exported = exportStudioDocument(dirty)
    expect(exported).not.toContain('SECRET_')
    expect(exported).not.toContain('running')
    expect(importStudioDocument(exported)).toEqual(sanitizeStudioDocument(dirty))
  })

  it.each(['__proto__', 'constructor', 'prototype'])('rejects dangerous %s keys even in ignored fields', key => {
    const data = JSON.parse(JSON.stringify(createStudioDocument()))
    data.ignored = JSON.parse(`{"${key}":{"polluted":true}}`)
    expect(() => sanitizeStudioDocument(data)).toThrowError(expect.objectContaining({ code: 'UNSAFE_DATA' }))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects custom prototypes and accessors without invoking getters', () => {
    const getter = vi.fn(() => 'secret')
    const document = createStudioDocument()
    Object.defineProperty(document, 'ignored', { get: getter, enumerable: true })
    expect(() => sanitizeStudioDocument(document)).toThrowError(expect.objectContaining({ code: 'UNSAFE_DATA' }))
    expect(getter).not.toHaveBeenCalled()
    expect(() => sanitizeStudioDocument(Object.assign(Object.create({ inherited: true }), createStudioDocument()))).toThrow()
  })

  it('keeps markup as literal text and never turns it into HTML', () => {
    const document = createStudioDocument()
    document.nodes.push(createStudioNode('text', { x: 0, y: 0 }, { text: '<img src=x onerror=alert(1)>' }))
    expect(importStudioDocument(exportStudioDocument(document)).nodes[0].data).toEqual({ text: '<img src=x onerror=alert(1)>' })
  })

  it.each(['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'blob:https://sshzyu.com/123', 'http://other.test/image.png', 'https://user:password@example.com/a.png'])('rejects unsafe image URL %s', url => {
    expect(normalizeStudioImageUrl(url, 'http://localhost:3000')).toBeNull()
  })

  it('allows HTTPS outputs and same-origin paths, but rejects SVG MIME', () => {
    expect(normalizeStudioImageUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
    expect(normalizeStudioImageUrl('/image.png', 'http://localhost:3000')).toBe('http://localhost:3000/image.png')
    const { document, reference } = board()
    reference.data.images = [{ id: 'image-url', kind: 'url', url: 'https://cdn.example.com/a.svg', mimeType: 'image/svg+xml' } as never]
    expect(() => sanitizeStudioDocument(document)).toThrowError(expect.objectContaining({ code: 'INVALID_IMAGE_TYPE' }))
    expect(() => sanitizeStudioImageRef({ id: 'image-svg', kind: 'url', url: 'https://cdn.example.com/a.svg' }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_IMAGE_TYPE' }))
    expect(sanitizeStudioImageRef({ id: 'image-png', kind: 'url', url: 'https://cdn.example.com/a.png' }))
      .toMatchObject({ mimeType: 'image/png' })
  })

  it('rejects conflicting MIME declarations for the same local asset', () => {
    const { document, reference, generate } = board()
    generate.data.referenceImages = [{ ...reference.data.images[0], mimeType: 'image/jpeg' }]
    expect(() => sanitizeStudioDocument(document)).toThrowError(expect.objectContaining({ code: 'INVALID_IMAGE_TYPE' }))
  })

  it('rejects unsupported schemas, oversized boards, invalid coordinates and long prompts', () => {
    const { document, text } = board()
    expect(() => sanitizeStudioDocument({ ...document, schemaVersion: 2 })).toThrowError(expect.objectContaining({ code: 'SCHEMA_VERSION' }))
    expect(() => sanitizeStudioDocument({ ...document, nodes: Array(IMAGE_STUDIO_LIMITS.nodes + 1).fill(text) })).toThrowError(expect.objectContaining({ code: 'NODE_LIMIT' }))
    const bad = JSON.parse(JSON.stringify(document)) as ImageStudioDocument
    bad.nodes[0].position.x = Infinity
    expect(() => sanitizeStudioDocument(bad)).toThrowError(expect.objectContaining({ code: 'INVALID_DIMENSION' }))
    text.data.text = 'x'.repeat(IMAGE_STUDIO_LIMITS.textLength + 1)
    expect(() => sanitizeStudioDocument(document)).toThrowError(expect.objectContaining({ code: 'TEXT_LIMIT' }))
  })
})
