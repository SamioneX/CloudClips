import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function Navbar() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <nav style={styles.nav}>
      <div className="container" style={styles.inner}>
        <Link to="/" style={styles.logo}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ marginRight: '0.5rem' }}>
            <polygon points="4,2 18,10 4,18" fill="var(--accent)" />
          </svg>
          CloudClips
        </Link>

        <div style={styles.links}>
          <Link to="/" style={styles.link}>
            Videos
          </Link>

          {user ? (
            <>
              <Link to="/upload" style={styles.uploadBtn} className="btn btn-primary">
                Upload
              </Link>
              <span style={styles.email}>{user.email}</span>
              <button onClick={handleSignOut} style={styles.signOut} className="btn btn-ghost">
                Sign Out
              </button>
            </>
          ) : (
            <Link to="/login" style={{}} className="btn btn-ghost">
              Sign In
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}

const styles: Record<string, React.CSSProperties> = {
  nav: {
    position: 'sticky',
    top: 0,
    zIndex: 100,
    background: 'rgba(10, 10, 10, 0.85)',
    backdropFilter: 'blur(12px)',
    borderBottom: '1px solid var(--border)',
  },
  inner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '3.5rem',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    fontWeight: 700,
    fontSize: '1.0625rem',
    letterSpacing: '-0.01em',
  },
  links: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  link: {
    color: 'var(--text-muted)',
    fontSize: '0.875rem',
    padding: '0.25rem 0.5rem',
    borderRadius: '4px',
    transition: 'color 0.15s',
  },
  uploadBtn: {
    textDecoration: 'none',
  },
  email: {
    fontSize: '0.8125rem',
    color: 'var(--text-muted)',
    maxWidth: '180px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  signOut: {
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
