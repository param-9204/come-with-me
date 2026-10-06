"use client";

import { useEffect, useRef, useState } from "react";

import type { AdminPostSummary } from "@/lib/admin-posts";
import { cx } from "./ui";

/**
 * Tries each stored image URL, then the server thumbnail route, which can
 * re-fetch a fresh cover for Instagram posts whose signed CDN links expired.
 */
export default function Thumbnail({
  post,
  className,
}: {
  post: Pick<AdminPostSummary, "id" | "display_url" | "image_urls">;
  className?: string;
}) {
  const urls = [
    ...new Set(
      [post.display_url, ...post.image_urls].filter(
        (url): url is string => typeof url === "string" && url.length > 0,
      ),
    ),
    `/api/admin/posts/${post.id}/thumbnail`,
  ];
  const [index, setIndex] = useState(0);
  const imageRef = useRef<HTMLImageElement>(null);
  const url = urls[index];
  // Advance only past the URL that failed. A server-rendered image that fails
  // before hydration is reported twice (the mount check below and React's
  // replayed onError), and must not skip the next candidate.
  const failed = (failedUrl: string) =>
    setIndex((current) =>
      urls[current] === failedUrl && current < urls.length
        ? current + 1
        : current,
    );

  useEffect(() => {
    const image = imageRef.current;
    if (url && image?.complete && image.naturalWidth === 0) failed(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <div
      className={cx(
        "grid place-items-center overflow-hidden rounded bg-subtle",
        className,
      )}
    >
      {url ? (
        // Scraper CDN URLs expire and vary by host, so next/image is not used.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imageRef}
          key={url}
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => failed(url)}
          className="h-full w-full object-cover"
        />
      ) : (
        <svg
          aria-label="Image unavailable"
          role="img"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="h-4 w-4 text-ink-3"
        >
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="m3.5 16 5-5 4 4 2.5-2.5 5.5 5.5" />
          <circle cx="15.5" cy="9" r="1.5" />
        </svg>
      )}
    </div>
  );
}
