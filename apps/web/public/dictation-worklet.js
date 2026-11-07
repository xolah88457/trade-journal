/**
 * Web Audio Worklet processor for streaming raw PCM audio chunks.
 * Posts Float32Array audio buffers to the main thread for transcription and volume metering.
 */
class DictationProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Pass the first (mono) channel audio buffer
      this.port.postMessage(input[0]);
    }
    return true;
  }
}

registerProcessor("dictation-processor", DictationProcessor);
