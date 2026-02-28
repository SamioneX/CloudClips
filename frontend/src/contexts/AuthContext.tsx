import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { auth } from '../services/auth';

interface User {
  email: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session on mount
  useEffect(() => {
    auth
      .getCurrentEmail()
      .then((email) => setUser(email ? { email } : null))
      .finally(() => setLoading(false));
  }, []);

  const signIn = async (email: string, password: string) => {
    await auth.signIn(email, password);
    setUser({ email });
  };

  const signUp = async (email: string, password: string) => {
    await auth.signUp(email, password);
    // User must confirm via email code before signing in
  };

  const confirmSignUp = async (email: string, code: string) => {
    await auth.confirmSignUp(email, code);
  };

  const signOut = async () => {
    await auth.signOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, confirmSignUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
