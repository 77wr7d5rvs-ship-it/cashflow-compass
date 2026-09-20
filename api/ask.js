const recent = new Map();

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST to ask a question.' });

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host && new URL(origin).host !== host) {
    return res.status(403).json({ error: 'This tutor only accepts questions from its website.' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter(time => now - time < 60000);
  if (hits.length >= 6) return res.status(429).json({ error: 'Please wait a minute before asking another question.' });
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 2000) recent.clear();

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; }
  catch { return res.status(400).json({ error: 'Invalid request.' }); }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > 2000) {
    return res.status(400).json({ error: 'Please enter a question of 2,000 characters or fewer.' });
  }
  const history = Array.isArray(body.history) ? body.history.slice(-6)
    .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map(item => ({ role: item.role, content: item.content.slice(0, 1800) })) : [];

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'AI answers are not configured yet. The site owner must set OPENAI_API_KEY in Vercel and redeploy.' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        store: false,
        max_output_tokens: 1400,
        instructions: 'You are Cashflow Compass, a patient expert tutor in profit and loss statements, cash flow statements, accrual accounting, working capital and related business cases. Answer the actual question, not a preset keyword. Assume the learner is new. Start with a direct plain-English explanation, define unfamiliar terms, then show a small numerical example or steps when useful. Clearly distinguish P&L effects from cash timing and operating, investing or financing classification. For case questions, show calculations and assumptions step by step, point out uncertainty, and offer constructive feedback. Never invent figures or pretend to have read a file you have not been given. Avoid claiming infallibility. Keep the answer clear, substantive and usually under 500 words. Use plain text and short paragraphs.',
        input: [...history, { role: 'user', content: question }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('OpenAI request failed', response.status, data.error?.code || 'unknown');
      if (data.error?.code === 'credit_balance_exhausted') return res.status(503).json({ error: 'The tutor is connected, but its OpenAI API account has no credits. The site owner needs to add API credits before AI answers can work.' });
      if (response.status === 401) return res.status(502).json({ error: 'The tutor API key is invalid. The site owner needs to update it in Vercel.' });
      if (response.status === 429) return res.status(429).json({ error: 'The tutor is temporarily rate-limited. Please try again shortly.' });
      return res.status(502).json({ error: 'The tutor could not answer right now. Please try again shortly.' });
    }
    const answer = (data.output || []).filter(item => item.type === 'message')
      .flatMap(item => item.content || []).filter(item => item.type === 'output_text')
      .map(item => item.text).join('\n').trim();
    if (!answer) return res.status(502).json({ error: 'The tutor returned an empty answer. Please try again.' });
    return res.status(200).json({ answer });
  } catch (error) {
    console.error('Tutor error', error?.message || 'unknown');
    return res.status(502).json({ error: 'The tutor connection timed out. Please try again.' });
  }
}
