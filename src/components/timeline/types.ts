import type { NodePhase } from './MorphingNode';

/**
 * A single entry on the continuous timeline. User turns, assistant prose, and
 * tool executions all share one spine — there are no separate bubble lanes.
 */
export type TimelineEntry =
  | { id: string; kind: 'user'; text: string; images?: string[] }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      streaming?: boolean;
      // Conversational layer: `thinking` drives a breathing MorphingNode while the
      // turn is in flight; `toolsUsed` notes any MCP tools the model invoked;
      // `error` styles a failed turn (no key / API error); `images` are data: URIs
      // produced by tools during the turn (e.g. screenshots).
      thinking?: boolean;
      toolsUsed?: string[];
      error?: boolean;
      images?: string[];
    }
  | {
      id: string;
      kind: 'tool';
      tool: string;
      server?: string;
      phase: NodePhase;
      output?: string; // the tool result payload — unblurs/streams in
      streaming?: boolean; // true while the payload is still arriving
      images?: string[]; // data: URIs returned by the tool (e.g. screenshots)
    }
  | {
      // A two-stage image generation (§7). The Morphing Node breathes through both
      // stages; `stage` drives the label ("Expanding prompt…" → "Rendering image…").
      id: string;
      kind: 'image';
      prompt: string;
      stage: 'expanding' | 'rendering' | 'done' | 'error';
      route?: string; // 'flux' | 'ideogram' | 'placeholder'
      classification?: string; // 'typography_heavy' | 'standard'
      expandedPrompt?: string;
      image?: string; // data-URI or remote URL of the final render
      mock?: boolean; // true when any stage fell back to a placeholder
      note?: string; // human-readable degradation detail
      error?: string;
    };

/**
 * Map an image entry's pipeline stage onto the Morphing Node's visual phase.
 * Both live stages map to `processing` so the node breathes continuously across
 * an arbitrarily long render (never dissolving away mid-pipeline); the *label*
 * carries the "Expanding prompt…" → "Rendering image…" transition.
 */
export function imageStageToPhase(stage: 'expanding' | 'rendering' | 'done' | 'error'): NodePhase {
  switch (stage) {
    case 'expanding':
    case 'rendering':
      return 'processing';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
  }
}

export type { NodePhase };
