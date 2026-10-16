// WebSocket close codes, protocol §3.5.
export const CloseCode = {
  NORMAL: 1000,
  SERVICE_RESTART: 1001,
  UNAUTHORIZED: 4401,
  REVOKED: 4403,
  SUPERSEDED: 4409,
  VERSION_MISMATCH: 4426,
  RATE_LIMITED: 4429,
  INTERNAL_ERROR: 4500,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

const NO_RECONNECT: ReadonlySet<number> = new Set([
  CloseCode.UNAUTHORIZED,
  CloseCode.REVOKED,
  CloseCode.SUPERSEDED,
  CloseCode.VERSION_MISMATCH,
]);

export function reconnectOn(code: number): boolean {
  return !NO_RECONNECT.has(code);
}
