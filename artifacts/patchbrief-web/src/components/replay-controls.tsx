import { useEffect, useMemo, useState } from 'react';
import type { RunWithSteps } from '@workspace/api-client-react';
import { buildReplayFrames, type ReplayFrame } from '@/lib/replay';

export const REPLAY_BASE_MS = 1000;

function fmt(ms: number) { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`; }

// Local-only playback state. Frames are derived once from the saved snapshot; no fetches, no cache writes.
export function useReplay(saved: RunWithSteps | null) {
  const frames = useMemo<ReplayFrame[]>(() => (saved ? buildReplayFrames(saved) : []), [saved]);
  const [index, setIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);
  useEffect(() => {
    if (!playing || index == null) return;
    if (index >= frames.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setIndex((i) => (i == null ? 0 : i + 1)), REPLAY_BASE_MS / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, speed, frames.length]);
  return {
    frames, index, playing, speed, active: index != null,
    frame: index != null ? frames[index] : null,
    start: () => { setIndex(0); setPlaying(true); },
    pause: () => setPlaying(false),
    resume: () => { if (index != null && index >= frames.length - 1) setIndex(0); setPlaying(true); },
    restart: () => { setIndex(0); setPlaying(true); },
    exit: () => { setPlaying(false); setIndex(null); },
    toggleSpeed: () => setSpeed((s) => (s === 1 ? 2 : 1)),
  };
}

export type ReplayState = ReturnType<typeof useReplay>;

export function ReplayControls({ replay }: { replay: ReplayState }) {
  const { frame, index, frames, playing, speed, active } = replay;
  const shownMs = REPLAY_BASE_MS / speed;
  const gap = frame?.recordedGapMs;
  let timing = `Playback at ${speed}x, about ${fmt(shownMs)} per event.`;
  if (gap != null && index) {
    const ratio = gap / shownMs;
    timing = `Recorded gap ${fmt(gap)}, shown in ${fmt(shownMs)}: ${ratio >= 1 ? `sped up ${ratio.toFixed(1)}x` : `slowed down ${(1 / Math.max(ratio, 0.001)).toFixed(1)}x`} relative to recorded timing.`;
  }
  return <section className="replay-bar" data-testid="panel-replay">
    <div className="replay-buttons">
      {!active && <button type="button" className="copy-button" onClick={replay.start} data-testid="button-replay">Replay</button>}
      {active && (playing
        ? <button type="button" className="copy-button" onClick={replay.pause} data-testid="button-replay-pause">Pause</button>
        : <button type="button" className="copy-button" onClick={replay.resume} data-testid="button-replay-play">Play</button>)}
      {active && <button type="button" className="copy-button" onClick={replay.restart} data-testid="button-replay-restart">Restart</button>}
      <button type="button" className="copy-button" onClick={replay.toggleSpeed} aria-pressed={speed === 2} data-testid="button-replay-speed">{speed}x</button>
      {active && <button type="button" className="copy-button" onClick={replay.exit} data-testid="button-replay-exit">Show saved result</button>}
    </div>
    <div className="replay-info" aria-live="polite">
      {active && frame
        ? <><strong data-testid="text-replay-event">Event {(index ?? 0) + 1} / {frames.length}: {frame.label}</strong><span data-testid="text-replay-timing">{timing}</span></>
        : <span>Replay plays this saved run from the database record, step by step. Durations shown are the real recorded durations.</span>}
    </div>
  </section>;
}
