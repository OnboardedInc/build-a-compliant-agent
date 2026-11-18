// A synthetic microphone for call tests. The browser gets Chromium's fake capture device
// (fed a silent file, never the real microphone), and whatever audio track the call sends
// is swapped for a WebAudio track this script can speak into with window.__say(base64 wav).
// Launch the browser with `micArgs`: without the fake-device flags Chromium opens the real microphone.
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { outDir } from "./paths.mjs";

/** Two seconds of 48 kHz mono 16-bit silence, written by hand so no audio tool is needed. */
const silenceFile = () => {
  const file = resolve(outDir("audio"), "silence.wav");
  if (existsSync(file)) return file;
  const rate = 48000;
  const bytes = rate * 2 * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + bytes, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(bytes, 40);
  writeFileSync(file, wav);
  return file;
};

/** Chromium flags for the fake microphone. Makes tests/out/audio/silence.wav if it is missing. */
export const micArgs = () => [
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${silenceFile()}`,
];
export const micScript = () => {
  const audio = new AudioContext({ sampleRate: 48000 });
  const mic = audio.createMediaStreamDestination();
  // A very quiet noise floor, so the line is never digital silence.
  const noise = audio.createBuffer(1, 48000, 48000);
  for (let i = 0; i < 48000; i += 1) noise.getChannelData(0)[i] = (Math.random() - 0.5) * 0.001;
  const hiss = audio.createBufferSource();
  hiss.buffer = noise;
  hiss.loop = true;
  hiss.connect(mic);
  hiss.start();
  window.__speaking = false;
  window.__swapped = 0;
  window.__say = async (b64) => {
    await audio.resume();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buffer = await audio.decodeAudioData(bytes.buffer);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(mic);
    window.__speaking = true;
    source.onended = () => (window.__speaking = false);
    source.start();
    return buffer.duration;
  };
  const swap = (track) => {
    if (!track || track.kind !== "audio") return track;
    window.__swapped += 1;
    return mic.stream.getAudioTracks()[0];
  };
  const addTrack = RTCPeerConnection.prototype.addTrack;
  RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    return addTrack.call(this, swap(track), ...streams);
  };
  const addTransceiver = RTCPeerConnection.prototype.addTransceiver;
  RTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
    return addTransceiver.call(this, typeof trackOrKind === "string" ? trackOrKind : swap(trackOrKind), init);
  };
  const replaceTrack = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (track) {
    return replaceTrack.call(this, swap(track));
  };
};
