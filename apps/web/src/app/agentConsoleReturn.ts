/** 只接受同源 `/agent-console/` 下的登录回跳，拒绝开放重定向。 */
export function agentConsoleReturnPath(
  raw: string | null,
  origin: string,
): string | undefined {
  if (!raw || !raw.startsWith('/agent-console/')) return undefined
  const parsed = new URL(raw, origin)
  if (parsed.origin !== origin || !parsed.pathname.startsWith('/agent-console/')) return undefined
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}
