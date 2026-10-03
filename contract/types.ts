// Proposed contract between the ChatCut MCP server and a sandbox renderer.
// STATUS: proposal written before access to ChatCut internals. Field names are
// ccrender's; map them onto the real timeline model on day 1.

// ---- 1. capability probe: agent tells ChatCut what it can run --------------
// MCP tool (new): report_render_capabilities
export interface RenderCapabilities {
  host: 'cowork' | 'claude-code' | 'codex' | 'other';
  sandbox: boolean;            // false => fall back (browser WebCodecs or paid cloud)
  cpus: number; memGb: number; diskFreeGb: number;
  ffmpeg?: string;             // version string
  chromium: boolean;           // needed for motion-graphics layers
  maxCallSeconds?: number;     // e.g. Cowork tool-call limit; renderer checkpoints under it
}

// ---- 2. get_render_bundle: ChatCut -> sandbox ---------------------------------
// MCP tool (new): get_render_bundle({projectId, timelineId, range?, preset}) -> GetRenderBundleResult
// The Drive token travels next to the bundle, not inside it: the agent writes bundle.json to disk
// and passes the token to ccrender as env CCRENDER_DRIVE_TOKEN, so it never lands in a file.
export interface GetRenderBundleResult {
  bundle: RenderBundle;
  driveToken?: { accessToken: string; expiresAt: string };   // drive.file scope, this project only
}
export interface RenderBundle {
  version: 'render-bundle/0.1';
  renderId: string; projectId: string; timelineId: string;
  timeline: { fps: number; width: number; height: number; durationFrames: number };
  renderer: { name: string; version: string };      // pin: export must match editor preview
  assets: Record<string, Asset>;
  tracks: Track[];                                   // bottom -> top
  audio?: { ducking?: { threshold?: number; ratio?: number; attack?: number; release?: number } };
  output: { format: 'mp4'; codec: 'h264'; crf?: number };
  storage: {
    inputs: 'local' | 'drive';
    drive?: { folderId: string | null; /** @deprecated use GetRenderBundleResult.driveToken */ accessToken?: string | null };
  };
}
export interface Asset { type: 'video' | 'audio' | 'image'; src: string /* path | https:// | drive://<fileId> */; ext?: string }
export type Track =
  | { id: string; kind: 'video'; audioRole?: 'anchor' | 'follower'; volume?: number; hidden?: boolean; muted?: boolean; items: VideoItem[] }
  | { id: string; kind: 'motion'; items: MotionItem[] }
  | { id: string; kind: 'audio'; role?: 'anchor' | 'follower'; volume?: number; muted?: boolean; items: AudioItem[] }
  | { id: string; kind: 'captions'; style?: { font?: string; fontSize?: number; color?: string; marginV?: number }; cues: Cue[] };
interface Timed { id: string; start: number; duration: number }   // frames
export interface VideoItem extends Timed { asset: string; sourceStart?: number; speed?: number; audio?: boolean;
  rect?: { x: number; y: number; w: number; h: number };            // fractions of canvas; absent = full-frame cover
  opacity?: number; fadeIn?: number; fadeOut?: number; volume?: number }
export interface MotionItem extends Timed { component: string; props: Record<string, unknown> }
export interface AudioItem extends Timed { asset: string; sourceStart?: number; volume?: number; audioFadeIn?: number; audioFadeOut?: number }
export interface Cue { start: number; end: number; text: string }

// ---- 3. register_export: sandbox -> ChatCut ---------------------------------
// MCP tool (new): register_export(ExportManifest). ccrender writes this as out/export-manifest.json
export interface ExportManifest {
  renderId: string; projectId: string; timelineId: string;
  bundleHash: string;                                // sha256 of the bundle (minus storage)
  renderer: { name: string; version: string; codeHash: string };
  renderedAt: string; renderedOn: 'agent-sandbox';
  file: { name: string; bytes: number; sha256: string; driveFileId?: string };
  media: { durationSec: number; width: number; height: number; fps: number; videoCodec: string; audioCodec?: string };
  timings: Record<string, number>; invocations: number;
}
