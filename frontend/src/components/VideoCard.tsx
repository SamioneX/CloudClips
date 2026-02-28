import { Link } from 'react-router-dom';
import type { VideoRecord } from '../services/api';

function timeAgo(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Deterministic gradient color from videoId */
function gradientFromId(videoId: string): string {
  const hue = videoId.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
  const hue2 = (hue + 60) % 360;
  return `linear-gradient(135deg, hsl(${hue}, 55%, 18%), hsl(${hue2}, 55%, 12%))`;
}

interface Props {
  video: VideoRecord;
}

export function VideoCard({ video }: Props) {
  return (
    <Link to={`/videos/${video.videoId}`} style={styles.card}>
      {/* Thumbnail */}
      <div style={{ ...styles.thumbnail, background: gradientFromId(video.videoId) }}>
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={styles.playIcon}>
          <circle cx="20" cy="20" r="20" fill="rgba(0,0,0,0.35)" />
          <polygon points="16,12 30,20 16,28" fill="white" />
        </svg>
      </div>

      {/* Meta */}
      <div style={styles.meta}>
        <p style={styles.title}>{video.title}</p>
        <p style={styles.time}>{timeAgo(video.createdAt)}</p>
      </div>
    </Link>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: 'block',
    borderRadius: 'var(--radius)',
    overflow: 'hidden',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    transition: 'border-color 0.15s, transform 0.15s',
    cursor: 'pointer',
  },
  thumbnail: {
    aspectRatio: '16 / 9',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  playIcon: {
    opacity: 0.85,
  },
  meta: {
    padding: '0.75rem',
  },
  title: {
    fontSize: '0.875rem',
    fontWeight: 600,
    color: 'var(--text)',
    marginBottom: '0.25rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  time: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
  },
};
