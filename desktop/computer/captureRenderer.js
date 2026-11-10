import { AppendOnlyStreamTarget, AudioSample, AudioSampleSource, CanvasSource, Mp4OutputFormat, Output, WebMOutputFormat, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec } from './vendor/mediabunny.mjs';

let active = null;
// This script must never throw: Electron strips the message from page
// exceptions crossing executeJavaScript, which surfaces as "[object Object]"
// in the UI. Failures are reported through the finished IPC and the return
// value instead.
window.startComputerRecording = async ({ id, fps, width, speed = 1, format = 'mp4', audio = false }) => {
  if (active) return { started: false, error: 'Recording already started.' };
  const rate = Math.max(1, Math.min(10, Number(speed) || 1));
  let stream = null;
  const stopTracks = () => stream?.getTracks().forEach(track => track.stop());
  let failure = null, running = true, frameIndex = 0, stopPromise = null;
  const record = { id, stop: null, stream: null };
  active = record;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: Boolean(audio), video: { frameRate: { ideal: fps, max: fps }, width: { ideal: width, max: width } } });
    record.stream = stream;
    const sourceVideo = document.createElement('video'); sourceVideo.muted = true; sourceVideo.playsInline = true; sourceVideo.srcObject = stream; await sourceVideo.play();
    const trackSettings = stream.getVideoTracks()[0].getSettings();
    const aspect = (trackSettings.width || width) / Math.max(1, trackSettings.height || Math.round(width * 9 / 16));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = Math.max(1, Math.round(width / aspect));
    const context = canvas.getContext('2d', { alpha: false });
    // Fragmented MP4 (or WebM) writes every completed fragment straight to
    // disk through the main process, so the file stays playable even if the
    // app quits or the PC powers off before Stop is pressed.
    const output = new Output({
      format: format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      target: new AppendOnlyStreamTarget(new WritableStream({
        async write(chunk) { await window.computerRecordingBridge.chunk(id, chunk); },
      })),
    });
    const codec = await getFirstEncodableVideoCodec(format === 'webm' ? ['vp9', 'vp8'] : ['avc', 'vp9'], { width: canvas.width, height: canvas.height });
    if (!codec) throw new Error('No supported video encoder is available.');
    const bitrate = Math.min(20_000_000, Math.max(1_000_000, Math.round(canvas.width * canvas.height * fps * 0.08)));
    const source = new CanvasSource(canvas, { codec, bitrate });
    output.addVideoTrack(source);
    // Audio, when requested: 128 kbps AAC (MP4) or Opus (WebM). The frames are
    // pulled through MediaStreamTrackProcessor and handed to mediabunny as
    // WebCodecs AudioData — no AudioContext, which would sit suspended in this
    // gesture-less hidden window under Chromium's autoplay policy and silently
    // record silence. Loopback (system) audio arrives with the same stream.
    let audioSource = null, audioTrack = null;
    if (audio) {
      audioTrack = stream.getAudioTracks()[0] || null;
      if (audioTrack) {
        const audioSettings = audioTrack.getSettings();
        const audioCodec = await getFirstEncodableAudioCodec(format === 'webm' ? ['opus'] : ['aac', 'opus'], { numberOfChannels: Math.min(2, audioSettings.channelCount || 2), sampleRate: audioSettings.sampleRate || 48000 });
        if (audioCodec) {
          audioSource = new AudioSampleSource({ codec: audioCodec, bitrate: 128_000 });
          output.addAudioTrack(audioSource);
        }
      }
    }
    await output.start();
    // Playback speed compresses sample timestamps instead of racing the
    // capture, so the output plays back `rate` times faster with full motion.
    const frameDuration = 1 / (Math.max(1, fps) * rate);
    const paceMs = Math.max(4, Math.round(1000 / fps));
    record.stop = () => {
      running = false;
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        await pump.catch(() => {});
        await audioPump?.catch(() => {});
        sourceVideo.pause(); sourceVideo.srcObject = null; stopTracks();
        try { await output.finalize(); } catch (error) { failure ||= error.message || 'Finalizing the recording failed.'; }
        await window.computerRecordingBridge.finished(id, failure).catch(() => {});
      })();
      return stopPromise;
    };
    const pump = (async () => {
      while (running && !failure) {
        if (sourceVideo.readyState >= 2) {
          context.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
          try { await source.add(frameIndex * frameDuration, frameDuration); } catch (error) { failure = error.message || 'Video encoding failed.'; break; }
          frameIndex += 1;
        }
        await new Promise(resolve => setTimeout(resolve, paceMs));
      }
      // A storage or encoder failure self-terminates the recording so the run
      // never hangs in a broken state; the failure lands in the finished IPC.
      if (failure) void window.stopComputerRecording();
    })();
    // Audio runs on its own pump at the track's real-time rate. Frames carry
    // their own capture-clock timestamps, so they stay in sync with the video
    // (which is why audio is only offered at 1x speed).
    const audioPump = audioSource && (async () => {
      try {
        const reader = new MediaStreamTrackProcessor({ track: audioTrack }).readable.getReader();
        while (running && !failure) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) await audioSource.add(new AudioSample(value));
        }
      } catch (error) {
        if (running) { failure = error.message || 'Audio encoding failed.'; void window.stopComputerRecording(); }
      }
    })();
    stream.getVideoTracks()[0].onended = () => { window.stopComputerRecording(); };
    return { started: true, codec, width: canvas.width, height: canvas.height, audioEnabled: Boolean(audioSource) };
  } catch (error) {
    stopTracks();
    if (active === record) active = null;
    const message = error?.message || String(error) || 'The screen capture source was rejected or became unavailable.';
    void window.computerRecordingBridge.finished(id, `Recording could not start: ${message}`).catch(() => {});
    return { started: false, error: message };
  }
};
// Returns synchronously on purpose: the main process must never await the
// finalization here, because finalization reports back over the finished IPC
// and finish() tears the capture window down, which would leave a pending
// executeJavaScript unresolved forever.
window.stopComputerRecording = () => {
  const record = active;
  if (!record) return true;
  active = null;
  if (record.stop) void record.stop();
  else {
    record.stream?.getTracks().forEach(track => track.stop());
    void window.computerRecordingBridge.finished(record.id, 'Recording stopped during startup.').catch(() => {});
  }
  return true;
};
