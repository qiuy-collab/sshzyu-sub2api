import type { ApiKey } from '@/types'
import { keyAllowsBatchImage } from './batchImage'

/** A key handoff contains only an account-scoped ID; credentials are fetched after login. */
export function parseImageStudioKeyId(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return undefined
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

export function imageStudioKeyPath(value: unknown): string | undefined {
  const id = parseImageStudioKeyId(value)
  return id === undefined ? undefined : `/image-studio?keyId=${id}`
}

export function imageStudioKeyRoute(key: ApiKey): string | undefined {
  return keyAllowsBatchImage(key) ? imageStudioKeyPath(key.id) : undefined
}
