'use client';

/**
 * A compact connection-status pill (dot + label) driven by the `RemoteSocket`
 * status callback. No secrets — just the link state.
 */

import type { SocketStatus } from '@/lib/ws';

const META: Record<SocketStatus, { label: string; color: string }> = {
  connected: { label: 'Connected', color: '#34c759' },
  connecting: { label: 'Connecting…', color: '#ffb340' },
  reconnecting: { label: 'Reconnecting…', color: '#ffb340' },
  offline: { label: 'Offline', color: '#787880' },
};

export function ConnectionPill({ status }: { status: SocketStatus }) {
  const m = META[status];
  return (
    <span className="pill">
      <span className="pill-dot" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}
