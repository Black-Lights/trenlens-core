'use client';

/**
 * One timeline row. User text is shown verbatim (right-aligned); assistant answers
 * render as Markdown with the fake word-chunk reveal; errors get a distinct bubble.
 * While an assistant turn is in flight (empty text + streaming) we show typing dots.
 */

import { useStreamingText } from '@/lib/useStreamingText';

import { Markdown } from './Markdown';

export interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  /** Assistant: animate the word-chunk reveal of `text`. */
  streaming?: boolean;
  /** Assistant: tool (display) names the model invoked. */
  toolsUsed?: string[];
  /** Assistant: `data:` URIs of images produced by tools. */
  images?: string[];
  /** Error: the wire `code` (e.g. `no_key`). */
  code?: string;
}

export function MessageBubble({ item }: { item: ChatItem }) {
  if (item.role === 'user') {
    return (
      <div className="row user">
        <div className="bubble bubble-user">{item.text}</div>
      </div>
    );
  }
  if (item.role === 'error') {
    return (
      <div className="row assistant">
        <div className="bubble bubble-error">
          <span aria-hidden>⚠ </span>
          {item.text}
        </div>
      </div>
    );
  }
  return (
    <div className="row assistant">
      <AssistantBubble item={item} />
    </div>
  );
}

function AssistantBubble({ item }: { item: ChatItem }) {
  const { text, done } = useStreamingText(item.text, !!item.streaming);

  // Empty + streaming = waiting for the desktop's answer → typing indicator.
  if (item.streaming && item.text === '') {
    return (
      <div className="bubble bubble-assistant">
        <span className="typing">
          <span />
          <span />
          <span />
        </span>
      </div>
    );
  }

  return (
    <div className="bubble bubble-assistant">
      <Markdown>{text}</Markdown>
      {item.images?.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={i} className="bubble-img" src={src} alt="tool output" />
      ))}
      {done && item.toolsUsed && item.toolsUsed.length > 0 && (
        <div className="tools">used: {item.toolsUsed.join(', ')}</div>
      )}
    </div>
  );
}
