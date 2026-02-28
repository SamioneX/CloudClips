import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function ConfirmPage() {
  const { confirmSignUp } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const email = params.get('email') ?? '';
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await confirmSignUp(email, code.trim());
      navigate('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page container" style={styles.page}>
      <div style={styles.card} className="card">
        <h1 style={styles.title}>Check your email</h1>
        <p style={styles.subtitle}>
          We sent a 6-digit code to <strong style={{ color: 'var(--text)' }}>{email}</strong>.
          Enter it below to confirm your account.
        </p>

        {error && <p style={styles.error}>{error}</p>}

        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>
            Confirmation code
            <input
              type="text"
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              style={{ fontSize: '1.5rem', letterSpacing: '0.4em', textAlign: 'center' }}
            />
          </label>

          <button type="submit" className="btn btn-primary btn-lg" disabled={loading || code.length < 6} style={{ width: '100%' }}>
            {loading ? <span className="spinner" /> : 'Confirm Account'}
          </button>
        </form>

        <p style={styles.footer}>
          Wrong email?{' '}
          <Link to="/signup" style={styles.footerLink}>
            Start over
          </Link>
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: '5rem',
  },
  card: {
    width: '100%',
    maxWidth: '400px',
    padding: '2rem',
  },
  title: {
    fontSize: '1.25rem',
    fontWeight: 700,
    marginBottom: '0.5rem',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: '0.875rem',
    color: 'var(--text-muted)',
    textAlign: 'center',
    marginBottom: '1.5rem',
    lineHeight: 1.6,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    fontSize: '0.875rem',
    color: 'var(--text-muted)',
  },
  error: {
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.3)',
    color: 'var(--error)',
    padding: '0.625rem 0.875rem',
    borderRadius: 'var(--radius)',
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  footer: {
    marginTop: '1.25rem',
    textAlign: 'center',
    fontSize: '0.875rem',
    color: 'var(--text-muted)',
  },
  footerLink: {
    color: 'var(--accent)',
  },
};
