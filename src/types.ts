export type Phase = 'stopped' | 'preparing' | 'starting' | 'checking' | 'running' | 'stopping' | 'error'

export interface LogEntry {
  time: number
  text: string
}

export interface TunnelState {
  phase: Phase
  message: string
  target: string
  url?: string
  consoleUrl?: string
  startedAt?: number
  expiresAt?: number
  idleExpiresAt?: number
  lastActivityAt?: number
  requests: number
  bytesIn: number
  bytesOut: number
  defaultMinutes: number
  idleTimeoutMinutes: number
  logs: LogEntry[]
}

export interface Config {
  targetUrl: string
  ttlMinutes: number
  idleTimeoutMinutes: number
  autoDownload: boolean
  startupTimeout: number
  protocol: 'http2' | 'quic' | 'auto'
}
