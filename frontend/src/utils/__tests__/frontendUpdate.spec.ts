import { describe, expect, it, vi } from 'vitest'
import { moduleEntrypointFromHtml, probeFrontendUpdate } from '../frontendUpdate'

describe('frontend update probe', () => {
  it('uses only a same-origin module entrypoint', () => {
    expect(moduleEntrypointFromHtml('<script type="module" src="/assets/index-current.js"></script>', 'https://sshzyu.com')).toBe('https://sshzyu.com/assets/index-current.js')
    expect(moduleEntrypointFromHtml('<script type="module" src="https://elsewhere.example/app.js"></script>', 'https://sshzyu.com')).toBeNull()
  })

  it('reports a newer entrypoint and uses a cache-bypassing HTML request', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, text: async () => '<script type="module" src="/assets/index-next.js"></script>' })
    const update = await probeFrontendUpdate({ currentEntrypoint: 'https://sshzyu.com/assets/index-current.js', origin: 'https://sshzyu.com', now: 7, fetcher })

    expect(update).toBe('https://sshzyu.com/assets/index-next.js')
    expect(fetcher).toHaveBeenCalledWith('https://sshzyu.com/?__frontend_probe=7', expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }))
  })

  it('does not prompt when the deployed HTML has the same entrypoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, text: async () => '<script type="module" src="/assets/index-current.js"></script>' })
    await expect(probeFrontendUpdate({ currentEntrypoint: 'https://sshzyu.com/assets/index-current.js', origin: 'https://sshzyu.com', fetcher })).resolves.toBeNull()
  })
})
