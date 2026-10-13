// Tunn klient mot REST-API:t. Fel från servern kastas med serverns svenska meddelande.
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : undefined,
    body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'ERROR', data?.message ?? `Fel ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
};
