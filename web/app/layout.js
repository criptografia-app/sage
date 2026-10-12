import './globals.css';
import Providers from './providers';

export const metadata = {
  title: 'SAGE — talk to your agents',
  description: 'Safe Agentic Execution — social login, then chat to the publisher and signer bots.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
