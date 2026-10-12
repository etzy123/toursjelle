// "Ask the guide": a short spoken answer to a listener's question about the place they are at,
// grounded in that stop's story and (for tours made on the spot) its Wikipedia intro.
'use strict';

const MODEL = 'claude-opus-5-5';
const LANG_NAME = { en: 'English', nl: 'Dutch', de: 'German' };

const SYSTEM = `You are the guide's voice in a self-guided audio tour. A listener standing at a place asks you a question, and your answer is read aloud to them, so write it to be heard.

- Answer in the listener's language, in two to five short sentences, under 90 words. No lists, headings, parentheses, emojis or em dashes.
- Base the answer on the story and facts given for this place, and on well-established general knowledge. If you are not sure, say so plainly instead of guessing, and point them to something they can see or check nearby.
- Never make up names, dates, numbers or quotes.
- If the question has nothing to do with the tour or the place, answer briefly and kindly if you can, then steer back to the place.
- Be warm and direct, and careful and respectful about war, persecution or violence.`;

const clean = s => String(s || '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();

async function askGuide(anthropic, q) {
  const params = {
    model: MODEL, max_tokens: 4000, system: SYSTEM,
    output_config: { effort: 'low' }, // a short spoken answer; speed matters more than depth here
    messages: [{ role: 'user', content: JSON.stringify({
      language: LANG_NAME[q.lang] || 'English', city: q.city || null, place: q.place,
      story_told_here: q.story || null, facts_about_the_place: q.summary || null, question: q.question,
    }) }],
  };
  let msg;
  try {
    msg = await anthropic.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage();
  } catch (e) {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!(e instanceof Anthropic.BadRequestError)) throw e;
    msg = await anthropic.messages.stream(params).finalMessage();
  }
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('refused'), { code: 'refused' });
  const text = clean(msg.content.filter(b => b.type === 'text').map(b => b.text).join(' '));
  if (!text) throw new Error('empty answer');
  return text;
}

module.exports = { askGuide, SYSTEM };
