import brandLogo from '@/assets/sshzyu-mark.svg'

/** Presentation defaults only. Administrator settings remain the source of truth. */
export const BRAND_NAME = 'SSHZYU'
export const BRAND_LOGO = brandLogo

export function resolveBrandName(name?: string | null): string {
  const value = name?.trim()
  return !value || value === 'Sub2API' ? BRAND_NAME : value
}

export function resolveBrandSubtitle(subtitle?: string | null): string {
  const value = subtitle?.trim()
  return !value || value === 'Subscription to API Conversion Platform'
    ? 'AI, connected.'
    : value
}
