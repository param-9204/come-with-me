"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTarget = searchParams.get("redirect") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Handle URL error param if present
  useEffect(() => {
    if (searchParams.get("error") === "session_expired") {
      setError("Your session has expired. Please sign in again.");
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Please provide both email and password.");
      return;
    }

    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: email.trim(),
            password,
            rememberMe,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok || !data.success) {
          setError(data.error || "Invalid credentials. Please verify your .env settings.");
          return;
        }

        setIsSuccess(true);
        // Clean navigation to target URL
        const safeDestination =
          redirectTarget.startsWith("/") && !redirectTarget.startsWith("/login")
            ? redirectTarget
            : "/";
        
        setTimeout(() => {
          router.push(safeDestination);
          router.refresh();
        }, 500);
      } catch (err: any) {
        setError(err.message || "An unexpected error occurred. Please try again.");
      }
    });
  };

  return (
    <div className="relative min-h-screen w-full bg-[#09090b] text-zinc-100 flex items-center justify-center p-4 selection:bg-[#7A1626]/40 overflow-hidden font-sans">
      {/* Background ambient lighting in brand burgundy #7A1626 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[500px] bg-gradient-to-b from-[#7A1626]/20 via-[#5F111E]/12 to-transparent blur-3xl opacity-80" />
        <div className="absolute -bottom-40 right-1/4 w-[500px] h-[350px] bg-gradient-to-t from-[#7A1626]/15 via-transparent to-transparent blur-3xl opacity-50" />
        <div className="absolute inset-0 bg-[radial-gradient(#27272a_1px,transparent_1px)] [background-size:24px_24px] opacity-25" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Main Card */}
        <div className="relative rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-7 sm:p-9 shadow-2xl backdrop-blur-xl ring-1 ring-white/5 transition-all">
          {/* Top Brand Header */}
          <div className="flex flex-col items-center text-center space-y-3 mb-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#7A1626]/40 bg-[#7A1626]/15 px-3 py-1 text-[11px] font-medium text-[#e4a3af]">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#e4a3af] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#7A1626]"></span>
              </span>
              Come With Me · Internal Intelligence Portal
            </div>

            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-[#7A1626]/25 via-zinc-800 to-zinc-900 border border-[#7A1626]/40 shadow-inner text-[#e4a3af] mb-1">
              <svg
                className="w-7 h-7"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.75}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </div>

            <div>
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-100">
                Sign in to Dashboard
              </h1>
              <p className="text-xs sm:text-sm text-zinc-400 mt-1">
                Enter your credentials configured in the environment file
              </p>
            </div>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-950/40 p-3.5 text-xs text-red-300 animate-in fade-in slide-in-from-top-1 duration-200">
              <svg
                className="w-4 h-4 text-red-400 shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <div className="flex-1">
                <p className="font-medium text-red-200">Authentication Failed</p>
                <p className="mt-0.5 text-red-300/90 leading-relaxed">{error}</p>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-red-400 hover:text-red-200 p-0.5"
                aria-label="Dismiss error"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          )}

          {/* Success Banner */}
          {isSuccess && (
            <div className="mb-6 flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-3.5 text-xs text-emerald-300 animate-in fade-in duration-200">
              <svg
                className="w-4 h-4 text-emerald-400 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <p className="font-medium">Authentication successful! Redirecting...</p>
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email Field */}
            <div className="space-y-1.5">
              <label
                htmlFor="email"
                className="block text-xs font-medium text-zinc-300 tracking-wide uppercase"
              >
                Admin Email
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-zinc-500">
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.75}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207"
                    />
                  </svg>
                </div>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  placeholder="admin@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isPending || isSuccess}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 py-2.5 pl-10 pr-4 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-all focus:border-[#7A1626] focus:bg-zinc-950 focus:ring-2 focus:ring-[#7A1626]/30 disabled:opacity-50"
                />
              </div>
            </div>

            {/* Password Field */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="password"
                  className="block text-xs font-medium text-zinc-300 tracking-wide uppercase"
                >
                  Password
                </label>
              </div>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-zinc-500">
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.75}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                    />
                  </svg>
                </div>
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isPending || isSuccess}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 py-2.5 pl-10 pr-11 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-all focus:border-[#7A1626] focus:bg-zinc-950 focus:ring-2 focus:ring-[#7A1626]/30 disabled:opacity-50"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {showPassword ? (
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.75}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                      />
                    </svg>
                  ) : (
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.75}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                      />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Remember Me Option */}
            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="w-4 h-4 rounded border-zinc-700 bg-zinc-950 text-[#7A1626] focus:ring-[#7A1626]/30 focus:ring-offset-0 focus:ring-1 transition-colors accent-[#7A1626] cursor-pointer"
                />
                <span className="text-xs text-zinc-400">Remember this device (30 days)</span>
              </label>
            </div>

            {/* Submit Button in exact brand color #7A1626 */}
            <button
              type="submit"
              disabled={isPending || isSuccess}
              className="relative w-full mt-2 inline-flex items-center justify-center gap-2 rounded-xl bg-[#7A1626] hover:bg-[#5F111E] active:bg-[#4C0E18] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[#7A1626]/30 hover:shadow-[#7A1626]/50 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
            >
              {isPending ? (
                <>
                  <svg
                    className="w-4 h-4 animate-spin text-white/90"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  <span>Verifying Credentials...</span>
                </>
              ) : isSuccess ? (
                <>
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span>Authenticated!</span>
                </>
              ) : (
                <span>Sign In to Platform</span>
              )}
            </button>
          </form>

        </div>

        {/* Footer info note */}
        <p className="mt-4 text-center text-[11px] text-zinc-600">
          Come With Me Platform · Confidential &amp; Proprietary
        </p>
      </div>
    </div>
  );
}
