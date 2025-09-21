export default function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        speech: 'ready',
        gemini: 'ready'
      }
    });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
