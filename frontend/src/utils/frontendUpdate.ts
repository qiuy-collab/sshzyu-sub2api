export type FrontendFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'text'>>

function sameOriginEntry(source: string | null, origin: string): string | null {
  if (!source) return null
  try {
    const base = new URL(origin)
    const entry = new URL(source, base)
    return entry.origin === base.origin ? entry.href : null
  } catch {
    return null
  }
}

export function moduleEntrypointFromHtml(html: string, origin: string): string | null {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const source = document.querySelector('script[type="module"][src]')?.getAttribute('src') || null
  return sameOriginEntry(source, origin)
}

export function currentModuleEntrypoint(document: Document = window.document): string | null {
  const source = document.querySelector('script[type="module"][src]')?.getAttribute('src') || null
  return sameOriginEntry(source, document.location.origin)
}

export async function probeFrontendUpdate(options: {
  currentEntrypoint: string | null
  origin?: string
  now?: number
  fetcher?: FrontendFetch
}): Promise<string | null> {
  const { currentEntrypoint, origin = window.location.origin, now = Date.now(), fetcher = window.fetch.bind(window) } = options
  if (!currentEntrypoint) return null
  try {
    const response = await fetcher(`${origin.replace(/\/$/, '')}/?__frontend_probe=${now}`, {
      cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'text/html' },
    })
    if (!response.ok) return null
    const candidate = moduleEntrypointFromHtml(await response.text(), origin)
    return candidate && candidate !== currentEntrypoint ? candidate : null
  } catch {
    return null
  }
}
