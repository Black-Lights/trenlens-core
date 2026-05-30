'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders a settled assistant answer as Markdown (GFM: headings, lists, tables,
 * **bold**, `code`, fenced blocks). Styling lives in `.tren-md` (globals.css) so
 * it tracks the dual-theme tokens.
 *
 * It is used ONLY for the FINAL answer — while a turn is still streaming, the
 * per-character `<UnblurText>` animation runs on the raw text (markdown syntax is
 * sparse enough to read mid-stream). When the stream settles, this component
 * mounts and eases the formatted block in with the same `data-unblur` blur→sharp
 * mechanism, so the Typographic Unblur aesthetic is preserved end-to-end.
 */
export function Markdown({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="tren-md" data-unblur={shown ? 'out' : 'in'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links are inert in a desktop webview unless opened in the browser.
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
