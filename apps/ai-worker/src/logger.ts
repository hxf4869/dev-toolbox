type LogLevel = 'info' | 'warn' | 'error'

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level,
      service: 'ai-worker',
      event,
      ...fields,
    })}\n`,
  )
}
