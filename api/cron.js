import { createHmac } from 'crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function initFirebase() {
  if (getApps().length > 0) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
}

function makeSign(partnerKey, baseStr) {
  return createHmac('sha256', partnerKey).update(baseStr).digest('hex');
}

// Refresh access token
async function refreshAccessToken(partnerId, partnerKey, shopId, refreshToken) {
  const rt = String(refreshToken).trim();
  const timestamp = Math.floor(Date.now() / 1000);
  const baseStr = `${partnerId}/api/v2/auth/access_token/get${timestamp}`;
  const sign = makeSign(partnerKey, baseStr);
  const url = `https://partner.shopeemobile.com/api/v2/auth/access_token/get?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;
  const body = { partner_id: partnerId, shop_id: shopId, refresh_token: rt };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Refresh失敗: ${JSON.stringify(data)}`);
  return { accessToken: data.access_token, refreshToken: data.refresh_token || rt };
}

// 取得回覆率
async function getShopPerformance(partnerId, partnerKey, shopId, accessToken) {
  const at = String(accessToken).trim();
  const timestamp = Math.floor(Date.now() / 1000);
  const baseStr = `${partnerId}/api/v2/account_health/get_shop_performance${timestamp}${at}${shopId}`;
  const sign = makeSign(partnerKey, baseStr);
  const url = `https://partner.shopeemobile.com/api/v2/account_health/get_shop_performance?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&access_token=${encodeURIComponent(at)}&shop_id=${shopId}`;
  const res = await fetch(url);
  return await res.json();
}

// 台灣時間日期字串
function twDateStr(daysAgo = 0) {
  const tw = new Date(Date.now() + 8 * 3600000 - daysAgo * 86400000);
  return tw.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    initFirebase();
    const db = getFirestore();

    const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
    const partnerKey = process.env.SHOPEE_PARTNER_KEY;

    // 從環境袺���讀帳號（含 refreshToken）
    const accounts = JSON.parse(process.env.SHOPEE_ACCOUNTS);

    // ── 1. 對每個帳號 refresh token ──
    const freshTokens = {};
    const refreshErrors = [];
    for (const acct of accounts) {
      try {
        const fresh = await refreshAccessToken(partnerId, partnerKey, acct.shopId, acct.refreshToken);
        freshTokens[acct.acct] = { ...acct, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken };
      } catch (e) {
        refreshErrors.push(`帳號${acct.acct} refresh失敗: ${e.message}`);
        freshTokens[acct.acct] = acct; // 用舊的繼續嘗試
      }
    }

    // ── 2. 呼叫蝦皮 API 取得回覆率 ──
    const results = {};
    const apiErrors = [];
    for (const [acctName, tok] of Object.entries(freshTokens)) {
      try {
        const data = await getShopPerformance(partnerId, partnerKey, tok.shopId, tok.accessToken);
        const metrics = data?.response?.shop_performance?.performance_metrics ||
                        data?.response?.metric_list || [];
        const chatMetric = metrics.find(m => m.metric_id === 11);
        if (chatMetric) {
          results[acctName] = parseFloat(parseFloat(chatMetric.current_period).toFixed(2));
        } else {
          apiErrors.push(`帳號${acctName}: 找不到回覆率 (${data?.error || data?.message || JSON.stringify(data).slice(0,100)})`);
        }
      } catch (e) {
        apiErrors.push(`帳號${acctName}: ${e.message}`);
      }
    }

    // ── 3. 寫入昨天的回覆率到 Firebase（早上8點跑，記錄前一天資料）──
    const today = twDateStr(1);
    const writeResults = [];

    if (Object.keys(results).length > 0) {
      const docRef = db.collection('daily4').doc(today);
      const existing = await docRef.get();
      const existingData = existing.exists ? existing.data() : { date: today };
      const newData = { ...existingData, date: today, _cronUpdated: new Date().toISOString() };
      for (const [acct, val] of Object.entries(results)) {
        newData[`rr${acct}`] = val;
      }
      await docRef.set(newData);
      writeResults.push(`${today}: ${JSON.stringify(results)}`);
    }

    // ── 4. 把更新後的 refreshToken 存回 Firebase（供下次使用）──
    const tokenRecord = {};
    for (const [acct, tok] of Object.entries(freshTokens)) {
      tokenRecord[acct] = {
        shopId: tok.shopId,
        accessToken: tok.accessToken,
        refreshToken: tok.refreshToken,
      };
    }
    await db.collection('shopee_tokens').doc('accounts').set(tokenRecord);

    return res.status(200).json({
      success: true,
      today,
      results,
      writeResults,
      refreshErrors: refreshErrors.length ? refreshErrors : undefined,
      apiErrors: apiErrors.length ? apiErrors : undefined,
    });

  } catch (e) {
    console.error('Cron error:', e);
    return res.status(500).json({ error: e.message });
  }
}
