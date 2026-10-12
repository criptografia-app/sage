'use client';

import { PrivyProvider } from '@privy-io/react-auth';

/**
 * Wraps the app in Privy. Social login (email, Google, etc.) is the human
 * authentication layer — the logged-in identity becomes the `operator` the
 * SAGE agents already expect on signing actions.
 */
export default function Providers({ children }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    // Fail loud in the UI rather than silently rendering a broken login.
    return (
      <div className="gate">
        <h1>SAGE</h1>
        <p className="warn">
          NEXT_PUBLIC_PRIVY_APP_ID is not set. Create a Privy app at
          <br /> <code>dashboard.privy.io</code> and set the env var to enable login.
        </p>
      </div>
    );
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: { theme: 'dark', accentColor: '#7c5cff', logo: undefined },
        // Social + email login; also give each user an embedded wallet they can
        // use as their own Safe owner later.
        loginMethods: ['email', 'google', 'wallet'],
        embeddedWallets: { createOnLogin: 'users-without-wallets' },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
