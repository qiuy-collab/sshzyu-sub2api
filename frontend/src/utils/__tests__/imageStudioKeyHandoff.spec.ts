import { describe, expect, it } from 'vitest'
import type { ApiKey } from '@/types'
import { imageStudioKeyPath, imageStudioKeyRoute, parseImageStudioKeyId } from '../imageStudioKeyHandoff'

const key = {
  id: 42, key: 'secret-not-for-the-url', status: 'active',
  group: { platform: 'openai', allow_image_generation: true, allow_batch_image_generation: true },
} as ApiKey

describe('image studio key handoff', () => {
  it('builds a same-site route containing only the account-scoped key ID', () => {
    expect(imageStudioKeyRoute(key)).toBe('/image-studio?keyId=42')
    expect(imageStudioKeyRoute(key)).not.toContain(key.key)
    expect(imageStudioKeyPath('42')).toBe('/image-studio?keyId=42')
    expect(parseImageStudioKeyId('42')).toBe(42)
  })

  it('rejects malformed or repeated query values without interpreting them as routes', () => {
    for (const value of [undefined, null, '', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
      '0', '1.5', '1e2', ' 42 ', '42&apiKey=secret', 'https://elsewhere.example', ['42'], ['42', '43'], {}]) {
      expect(parseImageStudioKeyId(value)).toBeUndefined()
      expect(imageStudioKeyPath(value)).toBeUndefined()
    }
  })

  it('does not offer ordinary chat keys, disabled keys, or groups without batch permission', () => {
    expect(imageStudioKeyRoute({ ...key, status: 'inactive' })).toBeUndefined()
    expect(imageStudioKeyRoute({ ...key, group: null })).toBeUndefined()
    expect(imageStudioKeyRoute({ ...key, group: { ...key.group!, allow_batch_image_generation: false } })).toBeUndefined()
    expect(imageStudioKeyRoute({ ...key, group: { ...key.group!, allow_image_generation: false } })).toBeUndefined()
    expect(imageStudioKeyRoute({ ...key, group: { ...key.group!, platform: 'anthropic' } })).toBeUndefined()
  })

  it('also accepts eligible Gemini groups without copying credentials', () => {
    expect(imageStudioKeyRoute({ ...key, group: { ...key.group!, platform: 'gemini' } })).toBe('/image-studio?keyId=42')
  })
})
