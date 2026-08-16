/**
 * pipeline/tag.js
 * Offline keyword extraction and sentiment analysis using rule-based NLP.
 * No model download required — pure JavaScript.
 */

'use strict';

const POSITIVE_WORDS = new Set([
  'love','amazing','wonderful','fantastic','great','beautiful','happy',
  'joyful','grateful','thankful','best','incredible','outstanding',
  'excellent','perfect','brilliant','inspiring','heartfelt','cherish',
  'treasure','celebrate','proud','fun','laugh','smile','joy','memorable',
  'special','magical','extraordinary','blessed','lucky','honored','dear',
]);

const NEGATIVE_WORDS = new Set([
  'sad','miss','away','hard','difficult','tough','unfortunately','sorry',
  'wish','hoping','lost','gone','hurt','struggle','challenge','worried',
]);

const TOPIC_KEYWORDS = {
  family: ['family','mom','dad','brother','sister','son','daughter','grandma','grandpa','aunt','uncle','parent','children','wife','husband'],
  friendship: ['friend','buddy','pal','mate','crew','squad','bestie','friendship','together','years'],
  wedding: ['wedding','married','bride','groom','vows','love','couple','together','forever','marriage'],
  birthday: ['birthday','born','years','celebrate','older','wish','cake','party','age','year'],
  memory: ['remember','memory','recall','back','when','time','ago','once','years','story'],
  advice: ['advice','tip','lesson','learn','wisdom','know','tell','suggest','recommend'],
  funny: ['funny','hilarious','laugh','joke','humor','giggle','ridiculous','silly','story','incident'],
};

/**
 * Analyze text and return tags + sentiment.
 * @param {string} text
 * @returns {{ tags: string[], sentiment: 'positive'|'negative'|'neutral' }}
 */
function tagText(text) {
  if (!text || !text.trim()) return { tags: [], sentiment: 'neutral' };

  const lower = text.toLowerCase();
  const words = lower.split(/\W+/).filter(Boolean);

  // Sentiment scoring
  let posScore = 0, negScore = 0;
  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) posScore++;
    if (NEGATIVE_WORDS.has(word)) negScore++;
  }
  const sentiment = posScore > negScore ? 'positive'
    : negScore > posScore ? 'negative'
    : 'neutral';

  // Topic tagging
  const tags = [];
  for (const [topic, kws] of Object.entries(TOPIC_KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) tags.push(topic);
  }

  // Length-based tags
  const wordCount = words.length;
  if (wordCount < 20) tags.push('short');
  else if (wordCount > 100) tags.push('long');

  return { tags: [...new Set(tags)], sentiment };
}

module.exports = { tagText };
