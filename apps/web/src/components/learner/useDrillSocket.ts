'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHUNK_FRAMES,
  SAMPLE_RATE,
  hangupFrame,
  helloFrame,
  parseServerMessage,
  pcm16ToFloat,
} from '@/lib/drill-wire';

/**
 * The whole call, in one hook. No component touches the socket, the microphone or the
 * AudioContext; they read `state` and call `answer` or `hangUp`.
 *
 * Reconnecting is deliberately not here. When the model's own session nears its limit the agent
 * replaces it server side and carries the stage across, and the learner hears nothing. If *this*
 * socket dies, the call is over: a drill that silently resumed after a gap would be a different
 * call, and the session token is single use precisely so it cannot be re-used to start one.
 */

export type DrillPhase = 'ringing' | 'connecting' | 'in_call' | 'ended' | 'failed';

export interface DrillSocketState {
  phase: DrillPhase;
  secondsLeft: number | null;
  safeWord: string | null;
  /** The learner's own words, on the learner's own device. Never sent anywhere else. */
  caption: string;
  endReason: string | null;
  errorCode: string | null;
}

/** A jitter buffer. Long enough to absorb a wobble on mobile data, short enough to feel live. */
const PLAYBACK_LEAD_SECONDS = 0.12;
/** If this much audio is already waiting to go out, the network is the problem: drop, do not queue. */
const MAX_BUFFERED_BYTES = 192 * 1024;

const INITIAL: DrillSocketState = {
  phase: 'ringing',
  secondsLeft: null,
  safeWord: null,
  caption: '',
  endReason: null,
  errorCode: null,
};

export function useDrillSocket(drillId: string) {
  const [state, setState] = useState<DrillSocketState>(INITIAL);

  const socket = useRef<WebSocket | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const microphone = useRef<MediaStream | null>(null);
  const capture = useRef<AudioWorkletNode | null>(null);
  const playing = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartAt = useRef(0);
  const deadline = useRef<number | null>(null);
  /** Set once the agent has answered, so a close after that is not reported as a failure. */
  const finished = useRef(false);

  const stopPlayback = useCallback(() => {
    for (const source of playing.current) {
      try {
        source.stop();
      } catch {
        // already finished; nothing to stop
      }
    }
    playing.current.clear();
    nextStartAt.current = 0;
  }, []);

  const teardown = useCallback(() => {
    stopPlayback();
    capture.current?.port.close();
    capture.current?.disconnect();
    capture.current = null;
    microphone.current?.getTracks().forEach((track) => track.stop());
    microphone.current = null;
    const open = socket.current;
    socket.current = null;
    if (open && (open.readyState === WebSocket.OPEN || open.readyState === WebSocket.CONNECTING)) open.close();
    const context = audio.current;
    audio.current = null;
    void context?.close().catch(() => undefined);
    deadline.current = null;
  }, [stopPlayback]);

  useEffect(() => teardown, [teardown]);

  /**
   * Closes a drill the agent never took over, so it does not sit waiting and does not count
   * against the one-a-week cap. Once the agent owns the call this is a no-op on the server.
   */
  const releaseDrill = useCallback(async () => {
    try {
      await fetch(`/api/drills/${drillId}/end`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    } catch {
      // Best effort: the row also frees itself when its session token expires.
    }
  }, [drillId]);

  const fail = useCallback(
    (code: string) => {
      if (finished.current) return;
      finished.current = true;
      teardown();
      setState((current) => ({ ...current, phase: 'failed', errorCode: code }));
      void releaseDrill();
    },
    [releaseDrill, teardown],
  );

  const playChunk = useCallback((payload: ArrayBuffer) => {
    const context = audio.current;
    if (!context || payload.byteLength === 0) return;
    const samples = pcm16ToFloat(payload);
    // The buffer declares 16 kHz even when the context runs at another rate; the graph resamples.
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + PLAYBACK_LEAD_SECONDS, nextStartAt.current);
    source.start(startAt);
    nextStartAt.current = startAt + buffer.duration;
    playing.current.add(source);
    source.onended = () => playing.current.delete(source);
  }, []);

  const handleMessage = useCallback(
    (event: MessageEvent<string | ArrayBuffer>) => {
      if (event.data instanceof ArrayBuffer) {
        playChunk(event.data);
        return;
      }
      const message = parseServerMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case 'ready':
          deadline.current = Date.now() + message.maxSeconds * 1000;
          setState((current) => ({
            ...current,
            phase: 'in_call',
            safeWord: message.safeWord,
            secondsLeft: message.maxSeconds,
          }));
          break;
        case 'caption':
          // Only the learner's own words go on screen. The caller's are received and ignored:
          // a live transcript of the scammer would give away the drill.
          if (message.role === 'learner') {
            setState((current) => ({ ...current, caption: message.text }));
          }
          break;
        case 'clear':
          stopPlayback();
          break;
        case 'ended':
          finished.current = true;
          setState((current) => ({ ...current, phase: 'ended', endReason: message.reason, secondsLeft: 0 }));
          // Let whatever is already scheduled finish speaking before the socket goes.
          window.setTimeout(teardown, 400);
          break;
        case 'error':
          fail(message.code);
          break;
      }
    },
    [fail, playChunk, stopPlayback, teardown],
  );

  const answer = useCallback(async () => {
    if (state.phase !== 'ringing') return;
    setState((current) => ({ ...current, phase: 'connecting', errorCode: null }));

    // iOS Safari only unlocks audio inside the tap itself, so the context is created and resumed
    // first, before anything is awaited.
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: SAMPLE_RATE });
      audio.current = context;
      void context.resume();
    } catch {
      fail('audio_unavailable');
      return;
    }

    try {
      // The microphone is asked for before a token is minted: a learner who says no should not
      // have spent their one drill this week.
      microphone.current = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      fail('microphone_denied');
      return;
    }

    let session: { wsUrl: string; token: string };
    try {
      const response = await fetch(`/api/drills/${drillId}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        fail(body.error ?? 'session_refused');
        return;
      }
      session = (await response.json()) as { wsUrl: string; token: string };
    } catch {
      fail('session_refused');
      return;
    }

    try {
      await context.audioWorklet.addModule('/drill-capture-worklet.js');
    } catch {
      fail('audio_unavailable');
      return;
    }

    const ws = new WebSocket(session.wsUrl);
    ws.binaryType = 'arraybuffer';
    socket.current = ws;

    ws.onopen = () => {
      ws.send(helloFrame(session.token));
      const source = context.createMediaStreamSource(microphone.current!);
      const node = new AudioWorkletNode(context, 'drill-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { targetRate: SAMPLE_RATE, chunkFrames: CHUNK_FRAMES },
      });
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Stale microphone audio is worse than a gap, so a backlog is dropped, not queued.
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
        ws.send(event.data);
      };
      source.connect(node);
      capture.current = node;
    };
    ws.onmessage = handleMessage;
    ws.onerror = () => fail('connection_lost');
    ws.onclose = () => {
      if (!finished.current) fail('connection_lost');
    };
  }, [drillId, fail, handleMessage, state.phase]);

  const hangUp = useCallback(() => {
    const open = socket.current;
    if (open && open.readyState === WebSocket.OPEN) {
      open.send(hangupFrame());
      // The agent ends the call and sends `ended`; if it does not, this stops the wait.
      window.setTimeout(() => {
        if (!finished.current) {
          finished.current = true;
          teardown();
          setState((current) => ({ ...current, phase: 'ended', endReason: 'hangup' }));
        }
      }, 3000);
      return;
    }
    finished.current = true;
    teardown();
    setState((current) => ({ ...current, phase: 'ended', endReason: 'hangup' }));
    void releaseDrill();
  }, [releaseDrill, teardown]);

  const decline = useCallback(() => {
    finished.current = true;
    teardown();
    setState((current) => ({ ...current, phase: 'ended', endReason: 'declined' }));
    void releaseDrill();
  }, [releaseDrill, teardown]);

  useEffect(() => {
    if (state.phase !== 'in_call' || deadline.current === null) return;
    const tick = window.setInterval(() => {
      if (deadline.current === null) return;
      setState((current) => ({ ...current, secondsLeft: Math.max(0, Math.round((deadline.current! - Date.now()) / 1000)) }));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [state.phase]);

  return { state, answer, hangUp, decline };
}
