import { createHmac } from 'crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// 初始化 Firebase Admin
function initFirebase() {
  if (getApps().length > 0) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

// 產生蝦皮 API 簽名
function makeSign(partnerKey, baseStr) {
  return createHmac('sha256', partnerKey).update(baseStr).digest('hex');
}

// 呼叫蝦皮 get_shop_performance
async function getShopPerformance(partnerId, partnerKey, shopId, accessToken) {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseStr = `${partnerId}/api/v2/account_health/get_shop_performance${timestamp}${accessToken}${shopId}`;
  const sign = makeSign(partnerKey, baseStr);

  const url = `https://partner.shopeemobile.com/api/v2/account_health/get_shop_performance?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&access_token=${accessToken}&shop_id=${shopId}`;
  const res = await fetch(url);
  return await res.json();
}

export default async function handler(req, res) {
  // 安全驗證：只允許 Vercel Cron 呼叫
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    initFirebase();
    const db = getFirestore();

    const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
    const partnerKey = process.env.SHOPEE_PARTNER_KEY;

    // 每個帳號的設定（從環境變數讀取）
    const accounts = JSON.parse(process.env.SHOPEE_ACCOUNTS);

    // 今天日期（台灣時間 UTC+8）
    const now = new Date();
    const twOffset = 8 * 60 * 60 * 1000;
    const twNow = new Date(now.getTime() + twOffset);
    const dateStr = twNow.toISOString().slice(0, 10);

    const results = {};
    const errors = [];

    for (const acct of accounts) {
      try {
        const data = await getShopPerformance(partnerId, partnerKey, acct.shopId, acct.accessToken);
        const metrics = data?.response?.shop_performance?.performance_metrics || [];

        const chatMetric = metrics.find(m => m.metric_id === 11);
        if (chatMetric) {
          results[`rr${acct.acct}`] = parseFloat(parseFloat(chatMetric.current_period).toFixed(2));
        } else {
          errors.push(`帳號${acct.acct}: 找不到回覆率資料`);
        }
      } catch (e) {
        errors.push(`帳號${acct.acct}: ${e.message}`);
      }
    }

    if (Object.keys(results).length === 0) {
      return res.status(500).json({ error: '所有帳號都失敗', errors });
    }

    const docRef = db.collection('daily4').doc(dateStr);
    const existing = await docRef.get();
    const existingData = existing.exists ? existing.data() : { date: dateStr };

    const newData = {
      ...existingData,
      date: dateStr,
      ...results,
      _cronUpdated: new Date().toISOString()
    };

    await docRef.set(newData);

    return res.status(200).json({
      success: true,
      date: dateStr,
      results,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (e) {
    console.error('Cron error:', e);
    return res.status(500).json({ error: e.message });
  }
}
