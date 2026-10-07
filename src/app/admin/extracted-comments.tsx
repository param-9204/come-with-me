"use client";

import { type Data, type PostDetail, record, records } from "./post-components";
import { Panel, fmt } from "./ui";

export function apifyComments(detail: PostDetail): Data[] {
  return records(record(detail.related.apify).comments);
}

const optional = (value: unknown) =>
  typeof value === "string" && value ? value : null;

export default function ExtractedComments({ detail }: { detail: PostDetail }) {
  const comments = apifyComments(detail);

  return (
    <Panel
      title="Comments"
      description="Captured by Apify, in the order returned"
      flush
    >
      {comments.length ? (
        <ul className="divide-y divide-line">
          {comments.map((comment, index) => {
            const author = optional(comment.author);
            const name = optional(comment.name);
            const createdAt = optional(comment.created_at);
            const message = optional(comment.message);
            return (
              <li key={`${author || name || "comment"}-${index}`} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <p className="text-[13px] font-medium text-ink">
                    {author ? `@${author}` : name || "Unknown commenter"}
                    {author && name && (
                      <span className="ml-1.5 font-normal text-ink-3">
                        {name}
                      </span>
                    )}
                  </p>
                  <p className="flex gap-3 text-xs text-ink-3">
                    {createdAt && (
                      <time dateTime={createdAt}>{fmt.date(createdAt, true)}</time>
                    )}
                    {typeof comment.likes === "number" && (
                      <span>{fmt.number(comment.likes)} likes</span>
                    )}
                    {typeof comment.replies === "number" && (
                      <span>
                        {fmt.number(comment.replies)}{" "}
                        {comment.replies === 1 ? "reply" : "replies"}
                      </span>
                    )}
                  </p>
                </div>
                <p className="mt-1 text-[13px] leading-6 whitespace-pre-wrap text-ink-2">
                  {message || (
                    <span className="text-ink-3">No comment text was returned</span>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="p-4 text-[13px] text-ink-3">
          Apify did not return comments for this post.
        </p>
      )}
    </Panel>
  );
}
