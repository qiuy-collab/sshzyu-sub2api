import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireImageStudioTabLock,
  type ImageStudioTabLockManager,
} from '../imageStudioTabLock'

/** Shared manager models atomic exclusive grants and callback-lifetime ownership. */
function createLockManager() {
  const held = new Set<string>()
  const request = vi.fn<ImageStudioTabLockManager['request']>(async (name, _options, callback) => {
    await Promise.resolve()
    if (held.has(name)) return callback(null)
    held.add(name)
    try { await callback({ name, mode: 'exclusive' }) }
    finally { held.delete(name) }
  })
  return { request, held }
}

const releaseTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0))

afterEach(() => { vi.unstubAllGlobals() })

describe('imageStudioTabLock', () => {
  it('grants exactly one of many concurrent tabs for the same account', async () => {
    const lockManager = createLockManager()
    const attempts = await Promise.all(Array.from({ length: 20 }, () => acquireImageStudioTabLock(17, { lockManager })))
    const owners = attempts.filter(result => result.acquired)
    expect(owners).toHaveLength(1)
    expect(attempts.filter(result => !result.acquired && result.reason === 'locked')).toHaveLength(19)
    expect(lockManager.held.size).toBe(1)
    expect(lockManager.request).toHaveBeenCalledWith(
      'sshzyu:image-studio:edit:user:17', { mode: 'exclusive', ifAvailable: true }, expect.any(Function),
    )
    owners[0].release()
    await releaseTurn()
    expect(lockManager.held.size).toBe(0)
  })

  it('holds ownership after acquisition resolves and releases idempotently for a new editor', async () => {
    const lockManager = createLockManager()
    const first = await acquireImageStudioTabLock(42, { lockManager })
    await releaseTurn()
    expect(first.acquired).toBe(true)
    expect((await acquireImageStudioTabLock(42, { lockManager })).acquired).toBe(false)
    first.release()
    first.release()
    await releaseTurn()
    const next = await acquireImageStudioTabLock(42, { lockManager })
    expect(next.acquired).toBe(true)
    // A stale handle must not release the new owner's lock.
    first.release()
    expect((await acquireImageStudioTabLock(42, { lockManager })).acquired).toBe(false)
    next.release()
    await releaseTurn()
  })

  it('isolates accounts while a failed tab cannot release another editor', async () => {
    const lockManager = createLockManager()
    const [first, second] = await Promise.all([
      acquireImageStudioTabLock(101, { lockManager }), acquireImageStudioTabLock(202, { lockManager }),
    ])
    expect([first.acquired, second.acquired]).toEqual([true, true])
    const denied = await acquireImageStudioTabLock(101, { lockManager })
    denied.release()
    expect((await acquireImageStudioTabLock(101, { lockManager })).acquired).toBe(false)
    first.release()
    second.release()
    await releaseTurn()
  })

  it('uses the native manager by default and preserves its method receiver', async () => {
    const manager = createLockManager()
    const nativeLike: ImageStudioTabLockManager = {
      request(name, options, callback) {
        expect(this).toBe(nativeLike)
        return manager.request(name, options, callback)
      },
    }
    vi.stubGlobal('navigator', { locks: nativeLike })
    const result = await acquireImageStudioTabLock(5)
    expect(result.acquired).toBe(true)
    result.release()
    await releaseTurn()
  })

  it('fails closed for missing support and explicit null without attempting a lease fallback', async () => {
    vi.stubGlobal('navigator', {})
    expect(await acquireImageStudioTabLock(5)).toMatchObject({ acquired: false, reason: 'unsupported' })
    vi.stubGlobal('navigator', { locks: createLockManager() })
    expect(await acquireImageStudioTabLock(5, { lockManager: null })).toMatchObject({ acquired: false, reason: 'unsupported' })
    vi.stubGlobal('navigator', undefined)
    expect(await acquireImageStudioTabLock(5)).toMatchObject({ acquired: false, reason: 'unsupported' })
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid account identifier %s before requesting any lock', async (userId) => {
    const lockManager = createLockManager()
    const result = await acquireImageStudioTabLock(userId, { lockManager })
    expect(result).toMatchObject({ acquired: false, reason: 'invalid-user' })
    result.release()
    expect(lockManager.request).not.toHaveBeenCalled()
  })

  it.each(['throw', 'reject', 'no-callback'] as const)('fails closed when the lock request fails via %s', async (mode) => {
    const lockManager: ImageStudioTabLockManager = { request: () => {
      if (mode === 'throw') throw new DOMException('Storage denied', 'SecurityError')
      if (mode === 'reject') return Promise.reject(new DOMException('Storage denied', 'SecurityError'))
      return Promise.resolve()
    } }
    const result = await acquireImageStudioTabLock(12, { lockManager })
    expect(result).toMatchObject({ acquired: false, reason: 'unavailable' })
    result.release()
    await releaseTurn()
  })

  it('fails closed if accessing the browser lock manager itself throws', async () => {
    vi.stubGlobal('navigator', { get locks() { throw new DOMException('Denied', 'SecurityError') } })
    expect(await acquireImageStudioTabLock(12)).toMatchObject({ acquired: false, reason: 'unavailable' })
  })
})
