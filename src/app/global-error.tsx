'use client';

import React from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html>
      <body className="bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center min-h-screen p-4 font-sans">
        <div className="max-w-md w-full text-center space-y-4 bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-zinc-200">Something went wrong!</h2>
          <p className="text-sm text-zinc-500">
            A global application error occurred. Please try again.
          </p>
          <button
            onClick={() => reset()}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 transition-colors rounded-lg text-white text-sm font-medium"
          >
            Try Again
          </button>
        </div>
      </body>
    </html>
  );
}
