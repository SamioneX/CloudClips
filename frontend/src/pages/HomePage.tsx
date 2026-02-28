import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type VideoRecord } from '../services/api';
import { VideoCard } from '../components/VideoCard';

export function HomePage() {
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .listVideos(20)
      .then((res) => {
        setVideos(res.videos);
        setNextToken(res.nextToken);
      })
      .catch(() => setError('Failed to load videos'))
      .finally(() => setLoading(false));
  }, []);

  const loadMore = async () => {
    if (!nextToken) return;
    setLoadingMore(true);
    try {
      const res = await api.listVideos(20, nextToken);
      setVideos((prev) => [...prev, ...res.videos]);
      setNextToken(res.nextToken);
    } catch {
      setError('Failed to load more videos');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <main className="page container">
      {loading ? (
        <div style={styles.center}>
          <span className="spinner" style={{ width: '2rem', height: '2rem' }} />
        </div>
      ) : error ? (
        <div style={styles.center}>
          <p style={{ color: 'var(--error)' }}>{error}</p>
        </div>
      ) : videos.length === 0 ? (
        <div style={styles.empty}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ marginBottom: '1rem', opacity: 0.3 }}>
            <rect x="4" y="10" width="40" height="28" rx="4" stroke="currentColor" strokeWidth="2" fill="none" />
            <polygon points="20,18 34,24 20,30" fill="currentColor" />
          </svg>
          <p style={styles.emptyTitle}>No videos yet</p>
          <p style={styles.emptySubtitle}>Be the first to upload!</p>
          <Link to="/upload" className="btn btn-primary" style={{ marginTop: '1rem' }}>
            Upload a video
          </Link>
        </div>
      ) : (
        <>
          <div style={styles.grid}>
            {videos.map((v) => (
              <VideoCard key={v.videoId} video={v} />
            ))}
          </div>

          {nextToken && (
            <div style={styles.loadMore}>
              <button className="btn btn-ghost" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <span className="spinner" /> : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  center: {
    display: 'flex',
    justifyContent: 'center',
    paddingTop: '5rem',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingTop: '5rem',
    color: 'var(--text-muted)',
  },
  emptyTitle: {
    fontSize: '1.125rem',
    fontWeight: 600,
    color: 'var(--text)',
    marginBottom: '0.375rem',
  },
  emptySubtitle: {
    fontSize: '0.875rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '1.25rem',
  },
  loadMore: {
    display: 'flex',
    justifyContent: 'center',
    marginTop: '2.5rem',
  },
};
