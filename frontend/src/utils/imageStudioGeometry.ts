export interface StudioPoint { x: number; y: number }
export interface StudioViewport extends StudioPoint { zoom: number }
export const STUDIO_NODE_WIDTH = 280
export const studioNodeHeight = (type: string) => type === 'text' ? 240 : type === 'generate' ? 264 : 312
export const clampStudioZoom = (zoom: number) => Math.min(2.5, Math.max(0.2, zoom))
export const studioWorldPoint = (point: StudioPoint, viewport: StudioViewport): StudioPoint => ({
  x: (point.x - viewport.x) / viewport.zoom,
  y: (point.y - viewport.y) / viewport.zoom,
})
export function zoomStudioAt(viewport: StudioViewport, point: StudioPoint, zoom: number): StudioViewport {
  const world = studioWorldPoint(point, viewport)
  const next = clampStudioZoom(zoom)
  return { x: point.x - world.x * next, y: point.y - world.y * next, zoom: next }
}
export function fitStudioNodes(nodes: Array<{position: StudioPoint; type: string}>, width: number, height: number): StudioViewport {
  if (!nodes.length) return { x: 0, y: 0, zoom: 1 }
  const minX = Math.min(...nodes.map(n => n.position.x))
  const minY = Math.min(...nodes.map(n => n.position.y))
  const maxX = Math.max(...nodes.map(n => n.position.x + STUDIO_NODE_WIDTH))
  const maxY = Math.max(...nodes.map(n => n.position.y + studioNodeHeight(n.type)))
  const zoom = clampStudioZoom(Math.min(1, (width - 144) / (maxX - minX), (height - 144) / (maxY - minY)))
  return { x: (width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (height - (maxY - minY) * zoom) / 2 - minY * zoom, zoom }
}
export function studioEdgePath(from: StudioPoint, to: StudioPoint): string {
  const bend = Math.max(64, Math.abs(to.x - from.x) * 0.45)
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`
}
