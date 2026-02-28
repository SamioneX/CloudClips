/** Matches backend/src/shared/types.ts VideoRecord */
export interface VideoRecord {
  videoId: string;
  userId: string;
  status: 'UPLOADING' | 'PROCESSING' | 'MODERATING' | 'PUBLISHED' | 'QUARANTINED';
  title: string;
  description?: string;
  uploadKey: string;
  processedKeys?: Record<string, string>; // { '720p': 'videos/.../_720p.mp4', '360p': '...' }
  captionKey?: string;
  moderationLabels?: Array<{ name: string; parentName?: string; confidence: number }>;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

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

  return response.json() as Promise<T>;
}

export const api = {
  /** Get paginated feed of published videos */
  listVideos: (limit = 20, nextToken?: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (nextToken) params.set('nextToken', nextToken);
    return request<{ videos: VideoRecord[]; nextToken?: string }>(`videos?${params}`);
  },

  /** Get single video metadata */
  getVideo: (videoId: string) => request<VideoRecord>(`videos/${videoId}`),

  /** Record a view for a published video — fire-and-forget, returns updated viewCount */
  recordView: (videoId: string) =>
    request<{ viewCount: number }>(`videos/${videoId}/view`, { method: 'POST' }),

  /** Request a presigned upload URL (token = Cognito IdToken, no Bearer prefix) */
  createUpload: (title: string, contentType: string, token: string) =>
    request<{ videoId: string; uploadUrl: string; expiresIn: number }>('uploads', {
      method: 'POST',
      headers: { Authorization: token },
      body: JSON.stringify({ title, contentType, fileExtension: 'mp4' }),
    }),
};
