/**
 * API service for CloudClips backend.
 * Base URL will be set from environment/Amplify config.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error ?? `HTTP ${response.status}`);
  }

  return response.json();
}

export const api = {
  /** Get paginated feed of published videos */
  listVideos: (limit = 20, nextToken?: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (nextToken) params.set('nextToken', nextToken);
    return request<{ videos: unknown[]; nextToken?: string }>(`/videos?${params}`);
  },

  /** Get single video metadata */
  getVideo: (videoId: string) => request<unknown>(`/videos/${videoId}`),

  /** Request a presigned upload URL */
  createUpload: (title: string, contentType: string, token: string) =>
    request<{ videoId: string; uploadUrl: string; expiresIn: number }>('/uploads', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title, contentType, fileExtension: 'mp4' }),
    }),
};
