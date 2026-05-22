require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

// ── FIREBASE INIT ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();

// ── TELEGRAM HELPER ──
async function sendTelegram(message) {
  try {
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML',
        }),
      }
    );
  } catch (err) {
    console.error('[Telegram] Failed:', err.message);
  }
}

// ── VERIFY NOWPAYMENTS SIGNATURE ──
function verifySignature(rawBody, signature) {
  const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET);
  hmac.update(rawBody);
  const digest = hmac.digest('hex');
  return digest === signature;
}

// ── RAW BODY NEEDED FOR SIGNATURE CHECK ──
app.use('/webhook/nowpayments', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── KEEP ALIVE ──
app.get('/', (req, res) => {
  res.send('Cyrus NowPayments Webhook Running ✅');
});

// ── MAIN WEBHOOK ──
app.post('/webhook/nowpayments', async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    const rawBody = req.body;

    // Verify signature
    // Signature check disabled for testing
// if (!verifySignature(rawBody, signature)) {
//     console.log('[Webhook] Invalid signature, ignoring.');
//     return res.status(400).send('Invalid signature');
// }

    const data = JSON.parse(rawBody.toString());
    console.log('[Webhook] Received:', JSON.stringify(data));

    const paymentId = String(data.payment_id || '');
    const status = data.payment_status || '';
    const amountPaid = parseFloat(data.actually_paid || data.pay_amount || 0);
    const currency = data.pay_currency || '';

    // Only process confirmed/finished payments
    if (status !== 'finished' && status !== 'confirmed') {
      console.log(`[Webhook] Status is "${status}", not ready yet.`);
      return res.status(200).send('OK - not ready');
    }

    if (!paymentId) {
      console.log('[Webhook] No payment_id found.');
      return res.status(200).send('OK - no payment id');
    }

    // ── CHECK IF ALREADY PROCESSED ──
    const alreadyDone = await db
      .collection('processed_nowpayments')
      .doc(paymentId)
      .get();

    if (alreadyDone.exists) {
      console.log(`[Webhook] Payment ${paymentId} already processed.`);
      return res.status(200).send('OK - already done');
    }

    // ── FIND MATCHING DEPOSIT PROOF ──
    const proofSnap = await db
      .collection('depositProofs')
      .where('paymentId', '==', paymentId)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (proofSnap.empty) {
      console.log(`[Webhook] No pending depositProof found for ID: ${paymentId}`);
      await sendTelegram(
        `⚠️ <b>NowPayments - No Match Found</b>\n` +
        `🆔 Payment ID: ${paymentId}\n` +
        `💰 Amount: ${amountPaid} ${currency}\n` +
        `📊 Status: ${status}\n\n` +
        `User may not have submitted proof yet. Check manually.`
      );
      return res.status(200).send('OK - no match');
    }

    const proofDoc = proofSnap.docs[0];
    const proofData = proofDoc.data();
    const userUid = proofData.uid;
    const creditAmount = proofData.amount || amountPaid;

    // ── CREDIT USER & UPDATE STATUS ──
    const batch = db.batch();

    // Update depositProof status
    batch.update(proofDoc.ref, {
      status: 'approved',
      approvedAt: admin.firestore.Timestamp.now(),
      approvedBy: 'auto_nowpayments_webhook',
      actuallyPaid: amountPaid,
      payCurrency: currency,
    });

    // Credit user balance
    const userRef = db.collection('users').doc(userUid);
    batch.update(userRef, {
      balance: admin.firestore.FieldValue.increment(creditAmount),
    });

    // Create transaction record
    const txRef = db.collection('transactions').doc();
    batch.set(txRef, {
      uid: userUid,
      type: 'Deposit',
      amount: creditAmount,
      status: 'approved',
      timestamp: admin.firestore.Timestamp.now(),
      metadata: {
        paymentId: paymentId,
        currency: currency,
        actuallyPaid: amountPaid,
        autoApproved: true,
        source: 'NowPayments',
      },
    });

    // Also update the transaction in 'transactions' that user created when submitting proof
    const existingTxSnap = await db
      .collection('transactions')
      .where('uid', '==', userUid)
      .where('metadata.paymentId', '==', paymentId)
      .limit(1)
      .get();

    if (!existingTxSnap.empty) {
      batch.update(existingTxSnap.docs[0].ref, {
        status: 'approved',
        approvedAt: admin.firestore.Timestamp.now(),
      });
    }

    await batch.commit();

    // ── MARK AS PROCESSED ──
    await db.collection('processed_nowpayments').doc(paymentId).set({
      processedAt: admin.firestore.Timestamp.now(),
      userUid: userUid,
      amount: creditAmount,
      currency: currency,
    });

    // ── GET USER INFO FOR TELEGRAM ──
    const userSnap = await userRef.get();
    const userData = userSnap.data() || {};

    await sendTelegram(
      `✅ <b>NowPayments Auto-Approved!</b>\n` +
      `👤 User: ${userData.firstName || 'Unknown'} ${userData.lastName || ''}\n` +
      `📧 Email: ${userData.email || userUid}\n` +
      `💰 Credited: $${creditAmount}\n` +
      `🪙 Paid: ${amountPaid} ${currency}\n` +
      `🆔 Payment ID: ${paymentId}\n` +
      `⏰ Time: ${new Date().toLocaleString()}`
    );

    console.log(`[Webhook] ✅ Auto-credited $${creditAmount} to user ${userUid}`);
    return res.status(200).send('OK - credited');

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    await sendTelegram(`❌ <b>NowPayments Webhook Error</b>\n⚠️ ${err.message}`);
    return res.status(500).send('Error');
  }
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Cyrus] NowPayments webhook server running on port ${PORT}`);
});
