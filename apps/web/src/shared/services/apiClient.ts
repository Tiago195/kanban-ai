const DEFAULT_BASE_URL = 'http://localhost:3333';

const baseUrl: string = import.meta.env.VITE_API_BASE_URL ?? DEFAULT_BASE_URL;

export interface HealthResponse {
  status: string;
  [key: string]: unknown;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API ${path} respondeu ${res.status}`);
  }
  return (await res.json()) as T;
}

export const apiClient = {
  baseUrl,
  request,
  getHealth(): Promise<HealthResponse> {
    return request<HealthResponse>('/health');
  },
};

export function getHealth(): Promise<HealthResponse> {
  return apiClient.getHealth();
}
