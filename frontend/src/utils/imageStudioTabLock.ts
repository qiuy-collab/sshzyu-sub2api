/** A narrow Web Locks interface so concurrency can be tested without browser globals. */
export interface ImageStudioTabLockManager {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: { name: string; mode: 'exclusive' | 'shared' } | null) => Promise<void>,
  ): Promise<unknown>
}

export type ImageStudioTabLockFailure = 'locked' | 'unsupported' | 'invalid-user' | 'unavailable'

export type ImageStudioTabLock =
  | { acquired: true; release: () => void; reason?: never }
  | { acquired: false; release: () => void; reason: ImageStudioTabLockFailure }

export interface ImageStudioTabLockOptions {
  /** Omit to use navigator.locks. Explicit null tests or selects fail-closed unsupported mode. */
  lockManager?: ImageStudioTabLockManager | null
}

function failure(reason: ImageStudioTabLockFailure): ImageStudioTabLock {
  return { acquired: false, reason, release: () => {} }
}

/**
 * One editor per account and origin, including its pending paid-image delivery.
 * The returned promise resolves on acquisition; the Web Locks callback remains
 * pending until release(), or until the browser destroys this document.
 *
 * Callers must release a late acquisition if their view has already unmounted.
 * There is deliberately no localStorage lease fallback: it cannot guarantee an
 * atomic claim across tabs. Unsupported or blocked Web Locks never allow edits.
 */
export async function acquireImageStudioTabLock(
  userId: number,
  options: ImageStudioTabLockOptions = {},
): Promise<ImageStudioTabLock> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return failure('invalid-user')

  let manager: ImageStudioTabLockManager | null | undefined
  try {
    manager = options.lockManager === undefined
      ? (typeof navigator === 'undefined' ? null : navigator.locks)
      : options.lockManager
    if (!manager || typeof manager.request !== 'function') return failure('unsupported')
  } catch {
    return failure('unavailable')
  }

  const lockManager = manager
  return new Promise<ImageStudioTabLock>((resolve) => {
    let decided = false
    let released = false
    let finishHolding: (() => void) | undefined
    const decide = (result: ImageStudioTabLock) => {
      if (decided) return
      decided = true
      resolve(result)
    }
    const release = () => {
      if (released) return
      released = true
      finishHolding?.()
    }

    try {
      const request = lockManager.request(
        `sshzyu:image-studio:edit:user:${userId}`,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (decided) return
          if (!lock) {
            decide(failure('locked'))
            return
          }
          await new Promise<void>((unlock) => {
            finishHolding = unlock
            decide({ acquired: true, release })
          })
        },
      )
      // Observe request rejection even after the acquisition promise has resolved;
      // rejected browser requests must never cause an unhandled rejection.
      void Promise.resolve(request).then(
        () => decide(failure('unavailable')),
        () => {
          release()
          decide(failure('unavailable'))
        },
      )
    } catch {
      release()
      decide(failure('unavailable'))
    }
  })
}
