/**
 * Auth service — wraps AWS Amplify Cognito integration.
 * Will be configured once Cognito stack outputs are available.
 */

// TODO: Configure Amplify with Cognito User Pool details
// import { Amplify } from 'aws-amplify';
// import { signIn, signUp, signOut, getCurrentUser } from 'aws-amplify/auth';
//
// Amplify.configure({
//   Auth: {
//     Cognito: {
//       userPoolId: import.meta.env.VITE_USER_POOL_ID,
//       userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
//     },
//   },
// });

export const auth = {
  signIn: async (_email: string, _password: string) => {
    // TODO: Implement with Amplify
    throw new Error('Not implemented');
  },

  signUp: async (_email: string, _password: string) => {
    // TODO: Implement with Amplify
    throw new Error('Not implemented');
  },

  signOut: async () => {
    // TODO: Implement with Amplify
    throw new Error('Not implemented');
  },

  getToken: async (): Promise<string> => {
    // TODO: Return JWT from current session
    throw new Error('Not implemented');
  },
};
