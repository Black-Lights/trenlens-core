'use client';

import { AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { ConnectionBar, type Connection } from '@/components/chat/ConnectionBar';
import { Composer } from '@/components/chat/Composer';
import { HistorySidebar } from '@/components/config/HistorySidebar';
import { ServerSidebar } from '@/components/config/ServerSidebar';
import { HoverSummon } from '@/components/overlay/HoverSummon';
import { AmbientField } from '@/components/timeline/AmbientField';
import { Timeline } from '@/components/timeline/Timeline';
import type { McpTool } from '@/lib/ipc';
import { seedFor, useMcp } from '@/lib/useMcp';

/**
 * Live chat surface. The timeline is driven by the real Rust MCP host through
 * `useMcp` — `list_mcp_servers` / `list_mcp_tools` populate the panel and the
 * ConnectionBar, `register_mcp_server` adds a stdio server on the fly, and
 * `call_mcp_tool` drives the Morphing Node lifecycle with Typographic Unblur on
 * the returned payload. No scripted turns remain.
 */
export default function Page() {
  const mcp = useMcp();
  const [input, setInput] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const connections: Connection[] = mcp.servers.map((s) => ({
    id: s.id,
    name: s.name,
    transport: s.transport,
    live: mcp.tools.some((t) => t.server === s.id),
  }));

  const pickTool = (tool: McpTool) => setInput(seedFor(tool));

  return (
    <main className="relative flex h-screen flex-col">
      <AmbientField active={mcp.busy} />
      <ConnectionBar
        connections={connections}
        configOpen={configOpen}
        onToggleConfig={() => setConfigOpen((v) => !v)}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
      />

      <div className="relative flex min-h-0 flex-1">
        <AnimatePresence>
          {historyOpen && (
            <HistorySidebar
              conversations={mcp.conversations}
              currentId={mcp.currentConversationId}
              ready={mcp.ready}
              onNewChat={() => void mcp.newChat()}
              onSelect={(id) => void mcp.loadConversation(id)}
              onClose={() => setHistoryOpen(false)}
            />
          )}
        </AnimatePresence>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex-1 overflow-y-auto">
            {mcp.entries.length === 0 ? (
              <EmptyState ready={mcp.ready} hasTools={mcp.tools.length > 0} onOpenConfig={() => setConfigOpen(true)} />
            ) : (
              <Timeline entries={mcp.entries} active={mcp.busy} />
            )}
          </div>
          <Composer value={input} onValueChange={setInput} onSend={mcp.dispatch} busy={mcp.busy} />
        </section>

        <AnimatePresence>
          {configOpen && (
            <ServerSidebar
              servers={mcp.servers}
              tools={mcp.tools}
              ready={mcp.ready}
              dbStatus={mcp.dbStatus}
              sealStatus={mcp.sealStatus}
              proxyStatus={mcp.proxyStatus}
              keyedProviders={mcp.keyedProviders}
              provider={mcp.provider}
              model={mcp.model}
              onProviderChange={mcp.setActiveProvider}
              onModelChange={mcp.setActiveModel}
              onRegister={mcp.registerServer}
              onSaveKey={mcp.saveApiKey}
              onStartProxy={mcp.startProxy}
              onStopProxy={mcp.stopProxy}
              onPickTool={pickTool}
              onClose={() => setConfigOpen(false)}
            />
          )}
        </AnimatePresence>
      </div>

      <HoverSummon />
    </main>
  );
}

function EmptyState({
  ready,
  hasTools,
  onOpenConfig,
}: {
  ready: boolean | null;
  hasTools: boolean;
  onOpenConfig: () => void;
}) {
  const offline = ready === false;
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="relative mb-6 grid h-16 w-16 place-items-center">
        <span
          className="absolute h-16 w-16 animate-breathe rounded-full"
          style={{ background: 'radial-gradient(circle, rgb(var(--c-pulse)/0.35), transparent 70%)' }}
        />
        <span className="relative h-3 w-3 rounded-full" style={{ background: 'rgb(var(--c-pulse))' }} />
      </div>
      <h1 className="text-balance text-2xl font-semibold tracking-tight text-ink">Orchestrate anything</h1>
      <p className="mt-2 max-w-sm text-balance text-[14px] text-ink-muted">
        {offline
          ? 'Running in browser preview — the native MCP host is offline. Launch the desktop app (tauri dev) to connect tools.'
          : hasTools
            ? 'Pick a tool from the panel, or type server::tool {json args} below to run it.'
            : 'Connect a local MCP server to begin — every tool it exposes lands on this timeline.'}
      </p>
      {!offline && !hasTools && (
        <button
          type="button"
          onClick={onOpenConfig}
          className="mt-5 rounded-full border border-hairline px-4 py-2 text-[13px] text-ink-muted transition-colors hover:border-pulse/60 hover:text-ink"
        >
          Add a server
        </button>
      )}
    </div>
  );
}
