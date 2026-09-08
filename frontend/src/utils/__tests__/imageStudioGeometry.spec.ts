import { describe, expect, it } from 'vitest'
import {
  clampStudioZoom, fitStudioNodes, STUDIO_NODE_WIDTH, studioEdgePath,
  studioNodeHeight, studioWorldPoint, zoomStudioAt,
} from '../imageStudioGeometry'

describe('imageStudioGeometry', () => {
  it.each([0.01, 0.4, 1, 2.5, 10])('keeps the world point under the cursor fixed when zooming to %s', zoom => {
    const viewport = { x: -320, y: 175, zoom: 0.75 }
    const cursor = { x: 493, y: 281 }
    const anchor = studioWorldPoint(cursor, viewport)
    const next = zoomStudioAt(viewport, cursor, zoom)
    expect(next.zoom).toBe(clampStudioZoom(zoom))
    const moved = studioWorldPoint(cursor, next)
    expect(moved.x).toBeCloseTo(anchor.x, 10)
    expect(moved.y).toBeCloseTo(anchor.y, 10)
    expect(viewport).toEqual({ x: -320, y: 175, zoom: 0.75 })
  })

  it('fits an empty board without invalid coordinates, including a not-yet-measured canvas', () => {
    expect(fitStudioNodes([], 1200, 800)).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(fitStudioNodes([], 0, 0)).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('fits negative world coordinates and mixed node heights within the visible margins', () => {
    const nodes = [
      { type: 'text', position: { x: -500, y: -300 } },
      { type: 'result', position: { x: 180, y: 40 } },
      { type: 'generate', position: { x: -40, y: -90 } },
    ]
    const width = 1280, height = 800, viewport = fitStudioNodes(nodes, width, height)
    for (const node of nodes) {
      const left = node.position.x * viewport.zoom + viewport.x
      const top = node.position.y * viewport.zoom + viewport.y
      const right = left + STUDIO_NODE_WIDTH * viewport.zoom
      const bottom = top + studioNodeHeight(node.type) * viewport.zoom
      expect(left).toBeGreaterThanOrEqual(72 - 0.001)
      expect(top).toBeGreaterThanOrEqual(72 - 0.001)
      expect(right).toBeLessThanOrEqual(width - 72 + 0.001)
      expect(bottom).toBeLessThanOrEqual(height - 72 + 0.001)
    }
  })

  it('converts screen positions correctly when the entire board is translated into negative space', () => {
    const world = { x: -900, y: -450 }, viewport = { x: 600, y: 480, zoom: 0.5 }
    const screen = { x: world.x * viewport.zoom + viewport.x, y: world.y * viewport.zoom + viewport.y }
    expect(studioWorldPoint(screen, viewport)).toEqual(world)
  })

  it.each([
    [{ x: -280, y: -150 }, { x: 80, y: 240 }],
    [{ x: 300, y: 100 }, { x: -500, y: -800 }],
    [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    [{ x: -999000, y: -999000 }, { x: 999000, y: 999000 }],
  ])('keeps edge endpoints exact and control coordinates finite for %o → %o', (from, to) => {
    const path = studioEdgePath(from, to)
    expect(path).not.toMatch(/NaN|Infinity|undefined/)
    const values = (path.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number)
    expect(values).toHaveLength(8)
    expect(values.every(Number.isFinite)).toBe(true)
    expect(values.slice(0, 2)).toEqual([from.x, from.y])
    expect(values.slice(-2)).toEqual([to.x, to.y])
  })
})
