export default async function handler(req, res) {
  // 允許來自任何 GitHub Pages 的請求
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'missing path' });

  // 組合目標網址（把 query 裡的 path 以外的參數全部帶過去）
  const { path: _, ...rest } = req.query;
  const params = new URLSearchParams(rest).toString();
  const targetUrl = `https://partner.shopeemobile.com/api/v2/${path}${params ? '?' + params : ''}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (req.method === 'POST' && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOpts);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
