'use strict';
/**
 * tts.service.js
 * ───────────────────────────────────────────────────────────
 * Generates TikTok-quality AI voices completely free using Microsoft Edge TTS.
 */

const fs      = require('fs');
const path    = require('path');
const { EdgeTTS } = require('node-edge-tts');
const { execSync } = require('child_process');
const { OpenAI } = require('openai');

/**
 * synthesize(text, outputPath)
 * -> Promise<string>  absolute path to the audio file
 */
async function synthesize(text, outputPath, voice = 'onyx') {
  const tempDir = path.dirname(outputPath);
  const mp3Path = path.join(tempDir, 'tts_raw.mp3');

  if (process.env.OPENAI_API_KEY) {
    console.log(`[TTS] Synthesizing ${text.length} chars (OpenAI TTS - ${voice})`);
    try {
      const openai = new OpenAI();
      
      // Map frontend voice to OpenAI voice (alloy, echo, fable, onyx, nova, shimmer)
      const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
      const aiVoice = validVoices.includes(voice) ? voice : 'onyx';

      const mp3 = await openai.audio.speech.create({
        model: 'tts-1',
        voice: aiVoice,
        input: text,
      });
      
      const buffer = Buffer.from(await mp3.arrayBuffer());
      fs.writeFileSync(mp3Path, buffer);
    } catch (err) {
      console.error('[TTS] OpenAI TTS failed, falling back to EdgeTTS:', err.message);
      await synthesizeEdge(text, mp3Path);
    }
  } else {
    console.log(`[TTS] Synthesizing ${text.length} chars (Edge TTS)`);
    await synthesizeEdge(text, mp3Path);
  }

  // Use FFmpeg to convert to a clean WAV file for downstream processing
  execSync(`ffmpeg -i "${mp3Path}" -c:a pcm_s16le -ar 44100 "${outputPath}" -y`, { stdio: 'ignore' });

  return outputPath;
}

async function synthesizeEdge(text, mp3Path) {
  // High-energy, TikTok-style male voice
  const edgeVoice = 'en-US-ChristopherNeural'; 
  const tts = new EdgeTTS({ voice: edgeVoice });
  await tts.ttsPromise(text, mp3Path);
}

module.exports = { synthesize };
