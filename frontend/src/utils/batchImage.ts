import type { ApiKey } from '@/types'

// Local presets, not an official 1K/2K/4K aspect-ratio table. Keep aligned with
// backend longest-edge billing and https://developers.openai.com/api/docs/guides/image-generation.
// Above 3,686,400 pixels is experimental; compatible upstream support may differ.
export const openAIImageSizes: Record<string, Record<string, string>> = {
  '1K': { '1:1': '1024x1024', '3:2': '1008x672', '2:3': '672x1008' },
  '2K': {
    '1:1': '2048x2048', '3:2': '2016x1344', '2:3': '1344x2016',
    '16:9': '2048x1152', '9:16': '1152x2048', '3:1': '2016x672', '1:3': '672x2016',
  },
  '4K': {
    '1:1': '2880x2880', '3:2': '3456x2304', '2:3': '2304x3456',
    '16:9': '3840x2160', '9:16': '2160x3840', '3:1': '3840x1280', '1:3': '1280x3840',
  },
}

export const batchImageMimeTypes = ['image/png', 'image/jpeg', 'image/webp']

export function supportsBatchImagePlatform(platform?: string): boolean {
  return platform === 'gemini' || platform === 'openai'
}

export function keyAllowsBatchImage(key: ApiKey): boolean {
  return key.status === 'active' &&
    supportsBatchImagePlatform(key.group?.platform) &&
    key.group?.allow_batch_image_generation === true &&
    (key.group.platform !== 'openai' || key.group.allow_image_generation === true)
}
