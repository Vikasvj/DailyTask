import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { getServiceSupabase, readEnv } from '../config/supabase.js';

function messaging() {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin credentials are not configured.');
  }
  const app = getApps().find((candidate) => candidate.name === 'dailytask-push') ??
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      projectId,
    }, 'dailytask-push');
  return getMessaging(app);
}

function stringData(input) {
  return Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : JSON.stringify(value),
  ]));
}

function invalidToken(code) {
  return code === 'messaging/invalid-registration-token' ||
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/installation-id-not-registered';
}

async function sendTokens(tokens, notification) {
  if (!tokens.length) return { sent: 0, failed: 0, invalid: 0 };
  const admin = messaging();
  const db = getServiceSupabase();
  const payload = {
    notification: { title: notification.title, body: notification.body },
    data: stringData(notification.data),
    android: {
      priority: 'high',
      notification: { channelId: 'dailytask_notifications', sound: 'default' },
    },
  };
  let sent = 0;
  let failed = 0;
  let invalid = 0;
  for (let offset = 0; offset < tokens.length; offset += 500) {
    const batch = tokens.slice(offset, offset + 500);
    const response = await admin.sendEachForMulticast({ ...payload, fids: batch.map((row) => row.fid) });
    const staleIds = [];
    response.responses.forEach((item, index) => {
      if (item.success) sent += 1;
      else if (invalidToken(item.error?.code)) {
        invalid += 1;
        staleIds.push(batch[index].id);
      } else failed += 1;
    });
    if (staleIds.length) {
      const { error } = await db.from('notification_devices')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .in('id', staleIds);
      if (error) throw new Error('Could not deactivate invalid push tokens.');
    }
  }
  return { sent, failed, invalid };
}

export async function sendToDevice(fid, notification) {
  const data = { ...stringData(notification.data), screen: notification.screen ?? 'notifications' };
  const db = getServiceSupabase();
  const { data: rows, error } = await db.from('notification_devices')
    .select('id,fid').eq('fid', fid).eq('is_active', true).limit(1);
  if (error) throw new Error('Could not load the registered push device.');
  return sendTokens(rows.map((row) => row), { ...notification, data });
}

export async function sendToSelectedDevices(deviceIds, notification) {
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) return { sent: 0, failed: 0, invalid: 0 };
  const db = getServiceSupabase();
  const { data: rows, error } = await db.from('notification_devices')
    .select('id,fid').in('id', deviceIds).eq('is_active', true);
  if (error) throw new Error('Could not load selected push devices.');
  return sendTokens(rows.map((row) => row), notification);
}

export async function sendToUser(userId, notification) {
  const db = getServiceSupabase();
  const { data: rows, error } = await db.from('notification_devices')
    .select('id,fid').eq('user_id', userId).eq('is_active', true)
    .order('last_used_at', { ascending: false }).limit(5000);
  if (error) throw new Error('Could not load the user push devices.');
  return sendTokens(rows.map((row) => row), notification);
}

export function firebaseReady() {
  const env = readEnv();
  return Boolean(env.SUPABASE_SERVICE_ROLE_KEY && process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
}
