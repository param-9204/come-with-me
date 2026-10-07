"use client";

import { useEffect, useMemo, useState } from "react";

import { Panel } from "./ui";

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
    <Panel
      title="Media"
      description={
        images === null
          ? "Checking which images still load…"
          : `${images.length} ${images.length === 1 ? "image" : "images"}`
      }
    >
      {images === null ? (
        <div className="flex gap-2" aria-hidden>
          {candidates.slice(0, 5).map((url) => (
            <div key={url} className="h-32 w-24 shrink-0 rounded-md bg-subtle" />
          ))}
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {images.map((url, index) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`Post media ${index + 1}`}
                className="h-32 w-24 rounded-md border border-line object-cover"
                referrerPolicy="no-referrer"
              />
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}
