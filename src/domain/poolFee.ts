/** Uniswap v4's pool-key marker for a hook-selected LP fee. */
export const DYNAMIC_FEE_FLAG = 0x80_00_00

/**
 * Pool-key fees use hundredths of a basis point. The dynamic marker is not a
 * numeric fee and must never be rendered as a percentage.
 */
export function formatPoolFee(fee: number): string {
  if (fee === DYNAMIC_FEE_FLAG) return 'Dynamic'
  return `${fee / 10_000}%`
}
