"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Panel } from "./ui";

type Props = {
  imageUrls: string[];
  primaryImageUrl?: string | null;
};

function validImageUrls(imageUrls: string[], primaryImageUrl?: string | null) {
  return [...new Set([primaryImageUrl, ...imageUrls])]
    .filter((url): url is string => typeof url === "string" && Boolean(url))
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

function ImagePreview({
  alt,
  url,
  onClose,
}: {
  alt: string;
  url: string;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousActiveElement = document.activeElement;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      if (previousActiveElement instanceof HTMLElement) {
        previousActiveElement.focus();
      }
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Media preview"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative max-h-[85vh] max-w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-2 shadow-2xl">
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close media preview"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/75 text-xl leading-none text-white hover:bg-black focus:outline-none focus:ring-2 focus:ring-accent"
        >
          &times;
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt}
          className="max-h-[calc(85vh-1rem)] max-w-full rounded object-contain"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>,
    document.body,
  );
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
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(
    null,
  );
  const closePreview = useCallback(() => setSelectedImageIndex(null), []);

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

  const selectedImage =
    images !== null && selectedImageIndex !== null
      ? images[selectedImageIndex]
      : null;

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
            <button
              key={url}
              type="button"
              onClick={() => setSelectedImageIndex(index)}
              className="shrink-0 cursor-zoom-in rounded-md focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-surface"
              aria-label={`Preview post media ${index + 1}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`Post media ${index + 1}`}
                className="h-32 w-24 rounded-md border border-line object-cover"
                referrerPolicy="no-referrer"
              />
            </button>
          ))}
        </div>
      )}
      {selectedImage && (
        <ImagePreview
          url={selectedImage}
          alt={`Post media ${(selectedImageIndex ?? 0) + 1} preview`}
          onClose={closePreview}
        />
      )}
    </Panel>
  );
}
