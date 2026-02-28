import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, type VideoRecord } from '../services/api';

const CDN = import.meta.env.VITE_VIDEO_CDN_URL;

function timeAgo(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

export function VideoPage() {
  const { videoId } = useParams<{ videoId: string }>();
  const [video, setVideo] = useState<VideoRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [quality, setQuality] = useState<'720p' | '360p'>('720p');
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const viewRecorded = useRef(false);

  useEffect(() => {
    if (!videoId) return;
    api
      .getVideo(videoId)
      .then(setVideo)
      .catch(() => setError('Video not found'))
      .finally(() => setLoading(false));
  }, [videoId]);

  const switchQuality = (q: '720p' | '360p') => {
    const vid = videoRef.current;
    if (!vid || q === quality) return;
    pendingSeek.current = vid.currentTime;
    setQuality(q);
  };

  const handlePlay = () => {
    if (viewRecorded.current || !videoId) return;
    viewRecorded.current = true;
    api.recordView(videoId).then(({ viewCount }) => {
      setVideo((v) => (v ? { ...v, viewCount } : v));
    }).catch(() => {/* ignore — view count is non-critical */});
  };

  const handleCanPlay = () => {
    if (pendingSeek.current !== null && videoRef.current) {
      videoRef.current.currentTime = pendingSeek.current;
      pendingSeek.current = null;
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '5rem' }}>
        <span className="spinner" style={{ width: '2rem', height: '2rem' }} />
      </div>
    );
  }

  if (error || !video) {
    return (
      <div className="page container" style={{ textAlign: 'center', paddingTop: '5rem' }}>
        <p style={{ color: 'var(--error)', marginBottom: '1rem' }}>{error || 'Video not found'}</p>
        <Link to="/" className="btn btn-ghost">← Back to feed</Link>
      </div>
    );
  }

  if (video.status !== 'PUBLISHED') {
    return (
      <div className="page container" style={{ textAlign: 'center', paddingTop: '5rem' }}>
        <p style={{ color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          This video is currently <strong style={{ color: 'var(--text)' }}>{video.status.toLowerCase()}</strong>.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
          {video.status === 'QUARANTINED'
            ? 'This video was removed due to policy violations.'
            : 'It will be available shortly after processing completes.'}
        </p>
        <Link to="/" className="btn btn-ghost">← Back to feed</Link>
      </div>
    );
  }

  const videoKey720 = video.processedKeys?.['720p'];
  const videoKey360 = video.processedKeys?.['360p'];
  const videoSrc = CDN + '/' + (quality === '720p' ? videoKey720 : videoKey360);
  const captionSrc = video.captionKey ? CDN + '/' + video.captionKey : null;

  return (
    <main className="page container" style={styles.page}>
      {/* Player */}
      <div style={styles.playerWrap}>
        <video
          ref={videoRef}
          key={videoSrc}
          controls
          style={styles.video}
          onPlay={handlePlay}
          onCanPlay={handleCanPlay}
        >
          <source src={videoSrc} type="video/mp4" />
          {captionSrc && <track kind="subtitles" src={captionSrc} srcLang="en" label="English" default />}
          Your browser does not support HTML5 video.
        </video>
      </div>

      {/* Metadata */}
      <div style={styles.meta}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>{video.title}</h1>

          {/* Quality toggle */}
          {videoKey360 && (
            <div style={styles.qualityGroup}>
              {(['720p', '360p'] as const).map((q) => (
                <button
                  key={q}
                  className={`btn ${quality === q ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => switchQuality(q)}
                  style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem' }}
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>

        <p style={styles.sub}>
          Uploaded {timeAgo(video.createdAt)}
          {' · '}
          {video.viewCount} view{video.viewCount !== 1 ? 's' : ''}
        </p>

        {video.description && (
          <p style={styles.description}>{video.description}</p>
        )}
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <Link to="/" className="btn btn-ghost">← Back to feed</Link>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: '860px',
  },
  playerWrap: {
    width: '100%',
    borderRadius: 'var(--radius)',
    overflow: 'hidden',
    background: '#000',
    aspectRatio: '16 / 9',
  },
  video: {
    width: '100%',
    height: '100%',
    display: 'block',
  },
  meta: {
    marginTop: '1rem',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '1rem',
    marginBottom: '0.375rem',
  },
  title: {
    fontSize: '1.25rem',
    fontWeight: 700,
    lineHeight: 1.3,
  },
  qualityGroup: {
    display: 'flex',
    gap: '0.375rem',
    flexShrink: 0,
  },
  sub: {
    fontSize: '0.875rem',
    color: 'var(--text-muted)',
  },
  description: {
    marginTop: '0.75rem',
    fontSize: '0.9375rem',
    color: 'var(--text-muted)',
    lineHeight: 1.6,
  },
};
