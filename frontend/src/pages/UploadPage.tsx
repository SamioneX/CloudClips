import { useRef, useState, type DragEvent, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { auth } from '../services/auth';

type UploadPhase = 'idle' | 'uploading' | 'polling' | 'done' | 'error';
type VideoStatus = 'UPLOADING' | 'PROCESSING' | 'MODERATING' | 'PUBLISHED' | 'QUARANTINED';

const STATUS_LABELS: Record<VideoStatus, string> = {
  UPLOADING: 'Uploaded to S3',
  PROCESSING: 'Transcoding (720p + 360p)…',
  MODERATING: 'AI moderation…',
  PUBLISHED: 'Published!',
  QUARANTINED: 'Removed (policy violation)',
};

/** Upload file directly to S3 presigned URL with XHR progress. */
function uploadToS3(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 200) resolve();
      else reject(new Error(`Upload failed: HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'video/mp4');
    xhr.send(file);
  });
}

export function UploadPage() {
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [videoStatus, setVideoStatus] = useState<VideoStatus | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setFileIfValid = (f: File | null) => {
    if (!f) return;
    if (f.type !== 'video/mp4') {
      setError('Only MP4 files are supported.');
      return;
    }
    setError('');
    setFile(f);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    setFileIfValid(e.dataTransfer.files[0] ?? null);
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFileIfValid(e.target.files?.[0] ?? null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !title.trim()) return;

    setError('');
    setPhase('uploading');
    setProgress(0);

    try {
      const token = await auth.getToken();
      const { videoId, uploadUrl } = await api.createUpload(title.trim(), 'video/mp4', token);

      await uploadToS3(uploadUrl, file, setProgress);

      setPhase('polling');
      setVideoStatus('UPLOADING');

      // Poll until terminal status
      const poll = setInterval(async () => {
        try {
          const video = await api.getVideo(videoId);
          setVideoStatus(video.status);
          if (video.status === 'PUBLISHED') {
            clearInterval(poll);
            setPublishedId(videoId);
            setPhase('done');
          } else if (video.status === 'QUARANTINED') {
            clearInterval(poll);
            setPhase('done');
          }
        } catch {
          // ignore transient poll errors
        }
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setPhase('error');
    }
  };

  const reset = () => {
    setTitle('');
    setFile(null);
    setPhase('idle');
    setProgress(0);
    setVideoStatus(null);
    setPublishedId(null);
    setError('');
  };

  return (
    <main className="page container" style={styles.page}>
      <h1 style={styles.heading}>Upload a Video</h1>

      {phase === 'idle' || phase === 'error' ? (
        <form onSubmit={handleSubmit} style={styles.form}>
          {/* Title */}
          <label style={styles.label}>
            Title
            <input
              type="text"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Give your video a title"
              required
              maxLength={120}
            />
          </label>

          {/* Drop zone */}
          <div
            style={{
              ...styles.dropzone,
              borderColor: dragging ? 'var(--accent)' : file ? 'var(--success)' : 'var(--border)',
              background: dragging ? 'rgba(99,102,241,0.05)' : 'var(--surface)',
            }}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ marginBottom: '0.75rem', opacity: 0.5 }}>
              <path d="M6 24 L6 10 Q6 6 10 6 L22 6 Q26 6 26 10 L26 24 Q26 28 22 28 L10 28 Q6 28 6 24Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <polygon points="13,13 22,17 13,21" fill="currentColor" />
            </svg>
            {file ? (
              <p style={styles.fileName}>
                <span style={{ color: 'var(--success)' }}>✓</span>{' '}
                {file.name}{' '}
                <span style={{ color: 'var(--text-muted)' }}>({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
              </p>
            ) : (
              <>
                <p style={styles.dropText}>Drop your MP4 here, or click to browse</p>
                <p style={styles.dropHint}>MP4 only · Max 5 minutes</p>
              </>
            )}
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={!file || !title.trim()}
            style={{ alignSelf: 'flex-start' }}
          >
            Upload Video
          </button>
        </form>
      ) : (
        /* Progress / status view */
        <div style={styles.statusCard} className="card">
          {phase === 'uploading' && (
            <>
              <p style={styles.statusLabel}>Uploading to S3…</p>
              <div style={styles.progressBar}>
                <div style={{ ...styles.progressFill, width: `${progress}%` }} />
              </div>
              <p style={styles.progressPct}>{progress}%</p>
            </>
          )}

          {(phase === 'polling' || phase === 'done') && videoStatus && (
            <>
              <p style={styles.statusLabel}>
                {videoStatus === 'QUARANTINED'
                  ? '❌ ' + STATUS_LABELS[videoStatus]
                  : videoStatus === 'PUBLISHED'
                  ? '✅ ' + STATUS_LABELS[videoStatus]
                  : '⏳ ' + STATUS_LABELS[videoStatus]}
              </p>

              {/* Step indicators */}
              <div style={styles.steps}>
                {(['UPLOADING', 'PROCESSING', 'MODERATING', 'PUBLISHED'] as VideoStatus[]).map((s, i) => {
                  const statuses: VideoStatus[] = ['UPLOADING', 'PROCESSING', 'MODERATING', 'PUBLISHED', 'QUARANTINED'];
                  const currentIdx = statuses.indexOf(videoStatus);
                  const stepIdx = statuses.indexOf(s);
                  const done = currentIdx > stepIdx;
                  const active = currentIdx === stepIdx;
                  return (
                    <div key={s} style={styles.step}>
                      <div style={{
                        ...styles.stepDot,
                        background: done ? 'var(--success)' : active ? 'var(--accent)' : 'var(--border)',
                      }} />
                      {i < 3 && <div style={{ ...styles.stepLine, background: done ? 'var(--success)' : 'var(--border)' }} />}
                      <p style={{ ...styles.stepLabel, color: done || active ? 'var(--text)' : 'var(--text-muted)' }}>
                        {s === 'UPLOADING' ? 'Uploaded' : s === 'PROCESSING' ? 'Transcoded' : s === 'MODERATING' ? 'Moderated' : 'Published'}
                      </p>
                    </div>
                  );
                })}
              </div>

              {phase === 'done' && publishedId && (
                <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.75rem' }}>
                  <Link to={`/videos/${publishedId}`} className="btn btn-primary">
                    Watch it now →
                  </Link>
                  <button className="btn btn-ghost" onClick={reset}>
                    Upload another
                  </button>
                </div>
              )}
              {phase === 'done' && videoStatus === 'QUARANTINED' && (
                <button className="btn btn-ghost" onClick={reset} style={{ marginTop: '1rem' }}>
                  Upload another
                </button>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: '640px',
  },
  heading: {
    fontSize: '1.5rem',
    fontWeight: 700,
    marginBottom: '1.75rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.25rem',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    fontSize: '0.875rem',
    color: 'var(--text-muted)',
  },
  dropzone: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2.5rem 1.5rem',
    border: '2px dashed',
    borderRadius: 'var(--radius)',
    cursor: 'pointer',
    transition: 'border-color 0.15s, background 0.15s',
    textAlign: 'center',
  },
  fileName: {
    fontSize: '0.9375rem',
    fontWeight: 500,
  },
  dropText: {
    fontSize: '0.9375rem',
    color: 'var(--text)',
    marginBottom: '0.25rem',
  },
  dropHint: {
    fontSize: '0.8125rem',
    color: 'var(--text-muted)',
  },
  error: {
    color: 'var(--error)',
    fontSize: '0.875rem',
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.3)',
    padding: '0.625rem 0.875rem',
    borderRadius: 'var(--radius)',
  },
  statusCard: {
    padding: '2rem',
  },
  statusLabel: {
    fontSize: '1rem',
    fontWeight: 600,
    marginBottom: '1rem',
  },
  progressBar: {
    height: '6px',
    borderRadius: '3px',
    background: 'var(--border)',
    overflow: 'hidden',
    marginBottom: '0.5rem',
  },
  progressFill: {
    height: '100%',
    background: 'var(--accent)',
    borderRadius: '3px',
    transition: 'width 0.3s',
  },
  progressPct: {
    fontSize: '0.875rem',
    color: 'var(--text-muted)',
  },
  steps: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0',
    marginTop: '1.25rem',
  },
  step: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    flex: 1,
    position: 'relative',
  },
  stepDot: {
    width: '12px',
    height: '12px',
    borderRadius: '50%',
    marginBottom: '0.5rem',
    zIndex: 1,
  },
  stepLine: {
    position: 'absolute',
    top: '6px',
    left: '50%',
    width: '100%',
    height: '2px',
    zIndex: 0,
  },
  stepLabel: {
    fontSize: '0.75rem',
    textAlign: 'center',
  },
};
