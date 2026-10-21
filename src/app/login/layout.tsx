import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign In · Come With Me Intelligence',
  description: 'Sign in to access the Come With Me social media intelligence scraper and admin portal.',
  robots: { index: false, follow: false },
};

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
