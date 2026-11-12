// Types for the monitor page's pure helpers, so the unit tests can import them.
// The page itself is plain JavaScript served as is; this file is never served.

export interface MonitorPageState {
  facts: Record<string, unknown> | null;
  limits: Record<string, unknown> | null;
  /** The gateway has a Set up and Settings backend. */
  setup: boolean;
  turns: Map<string, any>;
  order: string[];
  checks: any[];
}

export function splitBlocks(buffer: string): { blocks: string[]; rest: string };
export function parseBlock(block: string): any;
export function createState(): MonitorPageState;
export function applyEvent(state: MonitorPageState, event: any): string | null;
export function describeCall(call: { name: string; arguments: string }): string;
export function summarizeTurn(turn: any): { what: string; localOnly: boolean; flags: { label: string; tone: string }[]; meta: string[] };
export function shortId(id: unknown): string;
export function isTestSession(session: unknown): boolean;
export function landingTab(app: { account?: string | null; opencode?: { connected?: boolean } } | null): "turns" | "setup";
export function formatDuration(ms: number): string;
export function formatTime(iso: string): string;
export function linesLabel(count: number): string;
export function countLines(text: string): number;
