"use client";

import { useState } from "react";

import { date, type Data, type PostDetail, Section } from "./post-components";

function apifyComments(detail: PostDetail): Data[] {
  const apify =
    detail.related.apify &&
    typeof detail.related.apify === "object" &&
    !Array.isArray(detail.related.apify)
      ? (detail.related.apify as Data)
      : {};

  return Array.isArray(apify.comments) ? (apify.comments as Data[]) : [];
}

export default function ExtractedComments({ detail }: { detail: PostDetail }) {
  const comments = apifyComments(detail);
  const [expanded, setExpanded] = useState(false);

  return (
    <Section
      title="Extracted comments"
      note="Comments captured by Apify for this post"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="mb-4 flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-1 py-1 text-left hover:bg-zinc-800/50"
      >
        <p className="text-sm text-zinc-400">
          {comments.length
            ? "Comments are ordered exactly as returned by Apify."
            : "Apify did not return comments for this post."}
        </p>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs font-bold text-zinc-300">
            {comments.length}
          </span>
          <span aria-hidden className="text-sm text-zinc-400">
            {expanded ? "⌃" : "⌄"}
          </span>
        </span>
      </button>

      {expanded && comments.length > 0 && (
        <div className="space-y-3">
          {comments.map((comment, index) => {
            const author =
              typeof comment.author === "string" && comment.author
                ? comment.author
                : null;
            const name =
              typeof comment.name === "string" && comment.name
                ? comment.name
                : null;
            const createdAt =
              typeof comment.created_at === "string" && comment.created_at
                ? comment.created_at
                : null;
            const message =
              typeof comment.message === "string" && comment.message
                ? comment.message
                : null;

            return (
              <article
                key={`${author || name || "comment"}-${index}`}
                className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <p
                    title={name || undefined}
                    className="shrink-0 font-semibold text-zinc-100"
                  >
                    {author ? `@${author}` : name || "Unknown commenter"}
                  </p>
                  <p
                    title={message || "No comment text was returned"}
                    className="min-w-0 flex-1 truncate cursor-help text-sm text-zinc-300"
                  >
                    {message || "No comment text was returned"}
                  </p>
                  <div className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-500">
                    {createdAt && (
                      <time dateTime={createdAt}>{date(createdAt, true)}</time>
                    )}
                    {typeof comment.likes === "number" && (
                      <span>Likes: {comment.likes.toLocaleString()}</span>
                    )}
                    {typeof comment.replies === "number" && (
                      <span>
                        {comment.replies.toLocaleString()}{" "}
                        {comment.replies === 1 ? "reply" : "replies"}
                      </span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Section>
  );
}
