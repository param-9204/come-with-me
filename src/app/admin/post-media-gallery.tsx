"use client";

import { useEffect, useMemo, useState } from "react";

type Props = {
  imageUrls: string[];
  primaryImageUrl?: string | null;
};

function validImageUrls(imageUrls: string[], primaryImageUrl?: string | null) {
  return [...new Set(imageUrls)]
    .filter((url) => url !== primaryImageUrl)
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:";
      } catch {
        return false;
      }
    });
}

function canLoadImage(url: string) {
  return new Promise<string | null>((resolve) => {
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.onload = () => resolve(url);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

export default function PostMediaGallery({
  imageUrls,
  primaryImageUrl,
}: Props) {
  const candidateKey = validImageUrls(imageUrls, primaryImageUrl).join(
    "\u0000",
  );
  const candidates = useMemo(
    () => (candidateKey ? candidateKey.split("\u0000") : []),
    [candidateKey],
  );

  if (!candidates.length) return null;

  return <ValidatedMediaGallery key={candidateKey} candidates={candidates} />;
}

function ValidatedMediaGallery({ candidates }: { candidates: string[] }) {
  const [images, setImages] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all(candidates.map(canLoadImage)).then((results) => {
      if (!cancelled)
        setImages(results.filter((url): url is string => Boolean(url)));
    });

    return () => {
      cancelled = true;
    };
  }, [candidates]);

  if (images !== null && !images.length) return null;

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/65 p-5 shadow-2xl shadow-black/10">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-base font-bold text-white">Post media</h2>
        <p className="text-xs text-zinc-500">
          {images === null
            ? "Checking media…"
            : `${images.length} ${images.length === 1 ? "image" : "images"} available`}
        </p>
      </div>
      {images === null ? (
        <p className="text-sm text-zinc-500">Loading post media…</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {images.map((url) => (
            <img
              key={url}
              src={url}
              alt="Post media"
              className="h-40 w-32 shrink-0 rounded-xl border border-zinc-800 object-cover"
              referrerPolicy="no-referrer"
            />
          ))}
        </div>
      )}
    </section>
  );
}
