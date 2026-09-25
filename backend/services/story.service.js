'use strict';
const { OpenAI } = require('openai');

/**
 * clean(story) -> Promise<string>
 * Sanitises plain text suitable for TTS, using AI if API key is present.
 */
const MIN_CHARS = 50;
const MAX_CHARS = 3000;

function validate(story) {
  if (!story || typeof story !== 'string') return 'story is required and must be a string';
  const cleaned = story.trim();
  if (cleaned.length < MIN_CHARS) return `story is too short (minimum ${MIN_CHARS} characters)`;
  if (cleaned.length > MAX_CHARS) return `story is too long (maximum ${MAX_CHARS} characters)`;
  return null;
}

async function clean(story) {
  let cleaned = story
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ');

  // If we have an OpenAI or NVIDIA key, use an LLM to intelligently strip formatting and metadata
  if (process.env.OPENAI_API_KEY || process.env.NVIDIA_API_KEY) {
    try {
      let openai;
      let aiModel;

      if (process.env.NVIDIA_API_KEY) {
        openai = new OpenAI({
          apiKey: process.env.NVIDIA_API_KEY,
          baseURL: 'https://integrate.api.nvidia.com/v1',
        });
        aiModel = 'nvidia/nemotron-3-ultra-550b-a55b';
      } else {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        aiModel = 'gpt-4o-mini';
      }

      const response = await openai.chat.completions.create({
        model: aiModel,
        messages: [
          { role: 'system', content: 'You are a script formatter for a text-to-speech engine. The user will provide a story that may contain markdown formatting, blockquotes, conversational filler (e.g. "Here is a story for you:"), or other non-story text. Extract and return ONLY the raw story text without any markdown (no *, no _, no >, no headings) and without any conversational filler. Ensure paragraphs are separated by a single blank line. Do not output anything other than the story itself.' },
          { role: 'user', content: cleaned }
        ],
        temperature: 0.1,
        max_tokens: 2500,
      });
      cleaned = response.choices[0].message.content.trim();
    } catch (err) {
      console.warn('[StoryService] AI cleaning failed, falling back to regex:', err.message);
    }
  }

  // Fallback / secondary regex cleaning
  return cleaned
    .replace(/^#{1,6}\s+/gm, '') // Remove headers
    .replace(/^>\s*/gm, '')      // Remove blockquotes if any remain
    .replace(/\*\*/g, '')        // Remove bold
    .replace(/\*/g, '')          // Remove italics
    .replace(/https?:\/\/\S+/g, '') // Remove URLs
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { validate, clean };
