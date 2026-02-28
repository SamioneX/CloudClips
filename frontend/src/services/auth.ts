import {
  signIn as amplifySignIn,
  signUp as amplifySignUp,
  signOut as amplifySignOut,
  confirmSignUp as amplifyConfirmSignUp,
  getCurrentUser,
  fetchAuthSession,
  fetchUserAttributes,
} from 'aws-amplify/auth';

export const auth = {
  signIn: async (email: string, password: string): Promise<void> => {
    await amplifySignIn({ username: email, password });
  },

  signUp: async (email: string, password: string): Promise<void> => {
    await amplifySignUp({
      username: email,
      password,
      options: { userAttributes: { email } },
    });
  },

  confirmSignUp: async (email: string, code: string): Promise<void> => {
    await amplifyConfirmSignUp({ username: email, confirmationCode: code });
  },

  signOut: async (): Promise<void> => {
    await amplifySignOut();
  },

  /** Returns the current user's email, or null if not signed in. */
  getCurrentEmail: async (): Promise<string | null> => {
    try {
      await getCurrentUser();
      const attrs = await fetchUserAttributes();
      return attrs.email ?? null;
    } catch {
      return null;
    }
  },

  /** Returns the current session's ID token for API Authorization headers. */
  getToken: async (): Promise<string> => {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (!token) throw new Error('No active session');
    return token;
  },
};
