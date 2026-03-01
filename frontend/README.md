# frontend — React SPA

The CloudClips frontend is a React 18 + Vite 5 single-page application. It communicates directly with API Gateway and streams video from CloudFront. No backend-for-frontend — everything is static.

**Tech:** React 18 · Vite 5 · React Router v6 · AWS Amplify v6 · Plain CSS (no UI library)

---

## Structure

```
frontend/
├── public/
├── src/
│   ├── contexts/
│   │   └── AuthContext.tsx      # Auth state (user, signIn, signOut, …)
│   ├── components/
│   │   ├── Navbar.tsx           # Top navigation bar
│   │   ├── VideoCard.tsx        # Feed card (gradient thumbnail + metadata)
│   │   └── ProtectedRoute.tsx   # Redirects to /login if unauthenticated
│   ├── pages/
│   │   ├── HomePage.tsx         # Video feed grid + Load More
│   │   ├── VideoPage.tsx        # Video player + quality toggle + captions
│   │   ├── UploadPage.tsx       # Upload form + XHR progress + status polling
│   │   ├── LoginPage.tsx        # Sign in form
│   │   ├── SignupPage.tsx        # Sign up form
│   │   └── ConfirmPage.tsx      # Email verification code
│   ├── services/
│   │   ├── api.ts               # API client (listVideos, getVideo, createUpload…)
│   │   └── auth.ts              # Amplify v6 auth wrapper
│   ├── App.tsx                  # Router + AuthProvider
│   ├── main.tsx                 # Entry point — Amplify.configure() + ReactDOM
│   ├── index.css                # CSS custom properties + global styles
│   └── vite-env.d.ts            # VITE_* type declarations
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Routes

| Path | Component | Auth required | Description |
|---|---|---|---|
| `/` | `HomePage` | No | Public video feed grid |
| `/login` | `LoginPage` | No | Sign in form |
| `/signup` | `SignupPage` | No | Sign up form |
| `/confirm` | `ConfirmPage` | No | Email verification code |
| `/upload` | `UploadPage` | **Yes** | Upload a video |
| `/videos/:videoId` | `VideoPage` | No | Watch a video |

`ProtectedRoute` wraps `/upload` — unauthenticated users are redirected to `/login?next=/upload` and returned after sign-in.

---

## Key Components

### `AuthContext`

Provides auth state to the entire app via React Context:

```typescript
const { user, loading, signIn, signUp, confirmSignUp, signOut } = useAuth();
// user: { email: string } | null
// loading: boolean (true while restoring session on mount)
```

On mount, `AuthContext` calls `getCurrentUser()` to restore an existing Cognito session. The provider wraps the entire app in `App.tsx`.

### `Navbar`

- Logo + "Videos" link always visible
- "Upload" button (accent color) only shown when signed in
- Right side: either "Sign In" link, or `{email}` + "Sign Out" button

### `VideoCard`

Feed grid card with:
- **Gradient thumbnail** — hue derived from `videoId.charCodeAt(0) * 5 % 360`, giving each video a consistent unique color without requiring server-side thumbnail generation
- SVG play icon overlay
- Video title + relative timestamp (e.g. "2 minutes ago")
- Entire card is a `<Link to="/videos/{videoId}">` — no nested `<a>` tags

### `ProtectedRoute`

```tsx
<ProtectedRoute>
  <UploadPage />
</ProtectedRoute>
```

Shows a loading spinner while `AuthContext` restores the session. Redirects to `/login?next={currentPath}` if unauthenticated.

---

## Pages

### `HomePage` — Video feed

- Fetches `api.listVideos()` on mount
- Renders a 3-column responsive CSS grid of `<VideoCard>` components
- "Load More" button fetches the next page and appends videos to the list
- Empty state: "No videos yet. Be the first to upload!"

### `VideoPage` — Video player

- Fetches `api.getVideo(videoId)` on mount
- Calls `api.recordView(videoId)` once on mount (guarded so it only fires once)
- Renders a native `<video controls>` element at 16:9 aspect ratio
- Default quality: 720p (falls back to 360p if 720p not available)
- Quality toggle buttons swap `video.src` + seek back to `currentTime`
- Caption track: `<track kind="subtitles" src="{cdnUrl}/{captionKey}">` (rendered only when `captionKey` is present)

### `UploadPage` — Upload form

Upload flow:
1. User enters a title
2. Drag-and-drop zone (or click to browse) selects an MP4 file
3. On submit: call `api.createUpload()` → returns `{ videoId, uploadUrl }`
4. Use `XMLHttpRequest` (not `fetch`) to PUT the file to the presigned URL — `xhr.upload.onprogress` drives the progress bar
5. After upload completes, poll `api.getVideo(videoId)` every 3 seconds
6. Status indicator updates through: ✓ Uploaded → ⏳ Processing → ⏳ Moderating → ✓ Published (or ✗ Quarantined)
7. On publish: show "Watch it now →" link to `/videos/{videoId}`

> **Why XHR instead of `fetch`?** — `fetch` does not expose upload progress events. `XMLHttpRequest.upload.onprogress` is the only way to show a progress bar for a multipart or large file upload.

### `LoginPage` / `SignupPage` / `ConfirmPage`

Standard auth forms in a centered card:
- **Login**: email + password → `auth.signIn()` → navigate to `?next` or `/`
- **Signup**: email + password → `auth.signUp()` → navigate to `/confirm?email=...`
- **Confirm**: reads `?email` from URL params, 6-digit code input → `auth.confirmSignUp()` → navigate to `/login`

---

## Services

### `services/api.ts`

All API calls go through this module. Base URL is `import.meta.env.VITE_API_URL`.

```typescript
// List published videos (paginated)
listVideos(limit?: number, nextToken?: string): Promise<{ videos: VideoRecord[], nextToken?: string }>

// Get a single video's metadata
getVideo(videoId: string): Promise<VideoRecord>

// Increment view count
recordView(videoId: string): Promise<{ viewCount: number }>

// Create an upload record + get presigned URL
createUpload(title: string, contentType: string, idToken: string): Promise<{ videoId: string, uploadUrl: string }>
```

Protected endpoints pass the Cognito ID token as `Authorization: <token>` (no "Bearer " prefix — the API Gateway Cognito authorizer validates it directly).

### `services/auth.ts`

Thin wrapper around Amplify v6 auth functions:

```typescript
signIn(email: string, password: string): Promise<void>
signUp(email: string, password: string): Promise<void>
confirmSignUp(email: string, code: string): Promise<void>
signOut(): Promise<void>
getCurrentEmail(): Promise<string | null>  // null if not signed in
getToken(): Promise<string | null>         // Cognito ID token string
```

---

## Styling

CSS custom properties defined in `index.css`:

```css
:root {
  --bg: #0a0a0a;
  --surface: #161616;
  --border: #262626;
  --accent: #6366f1;       /* indigo */
  --text: #ededed;
  --text-muted: #71717a;
  --error: #ef4444;
  --success: #22c55e;
}
```

Global utility classes: `.container`, `.btn`, `.btn-primary`, `.btn-ghost`, `.input`, `.card`.

No external UI library — all components use plain CSS class names.

---

## Environment Variables

The frontend reads four environment variables at build time (Vite bakes them into the JS bundle):

| Variable | Description | Source |
|---|---|---|
| `VITE_API_URL` | API Gateway base URL | `CloudClips-Api` CFn output `ApiUrl` |
| `VITE_USER_POOL_ID` | Cognito User Pool ID | `CloudClips-Auth` CFn output `UserPoolId` |
| `VITE_USER_POOL_CLIENT_ID` | Cognito App Client ID | `CloudClips-Auth` CFn output `UserPoolClientId` |
| `VITE_VIDEO_CDN_URL` | CloudFront video CDN base URL | `CloudClips-Cdn` CFn output `VideoDistributionUrl` |

**For local development**, set them in `frontend/.env.local` (gitignored):

```bash
VITE_API_URL=https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/
VITE_USER_POOL_ID=us-east-1_xxxxxxxxx
VITE_USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_VIDEO_CDN_URL=https://d2xxxxxxxxx.cloudfront.net
```

To fetch values from the deployed stack automatically:
```bash
# From repo root
VITE_API_URL=$(aws cloudformation describe-stacks \
  --stack-name CloudClips-Api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" \
  --output text)

VITE_USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name CloudClips-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text)

VITE_USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name CloudClips-Auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text)

VITE_VIDEO_CDN_URL=$(aws cloudformation describe-stacks \
  --stack-name CloudClips-Cdn \
  --query "Stacks[0].Outputs[?OutputKey=='VideoDistributionUrl'].OutputValue" \
  --output text)

cat > frontend/.env.local <<EOF
VITE_API_URL=$VITE_API_URL
VITE_USER_POOL_ID=$VITE_USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$VITE_USER_POOL_CLIENT_ID
VITE_VIDEO_CDN_URL=$VITE_VIDEO_CDN_URL
EOF
```

**In CI (GitHub Actions)**, the deploy workflow fetches these values from CloudFormation and writes them to `$GITHUB_ENV` before running `pnpm build`, so they are available as process environment variables during the build.

---

## Commands

```bash
# Install dependencies (from repo root or frontend/)
pnpm install

# Start local dev server (http://localhost:5173)
pnpm dev

# Type check
pnpm typecheck

# Production build (output in dist/)
pnpm build

# Preview production build locally
pnpm preview
```

---

## Build and Deploy

The production build output (`dist/`) is a standard Vite static build:
- `index.html` — entry point (served for all routes via CloudFront 404 → 200 SPA fallback)
- `assets/` — hashed JS + CSS bundles

Deployment is handled by GitHub Actions:
```bash
aws s3 sync frontend/dist s3://cloudclips-frontend-<account> --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

Or manually via `scripts/deploy.sh`.
