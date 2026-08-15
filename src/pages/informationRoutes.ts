export type InformationPage = 'how' | 'methodology'

export function informationPageForPath(pathname: string): InformationPage | undefined {
  const normalized = pathname.replace(/\/+$/, '') || '/'

  if (normalized === '/how') return 'how'
  if (normalized === '/methodology') return 'methodology'
  return undefined
}
