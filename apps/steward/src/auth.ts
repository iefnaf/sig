export function bearer(request: Request): string | null {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}
