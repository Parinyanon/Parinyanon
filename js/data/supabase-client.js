import { validateConfig } from '../core/config-validation.js';
import { createTimedFetch } from '../core/network.js';

let clientPromise;
export async function getPublicFeatures() {
  try {
    const { config } = await import('./config.local.js');
    return { emailRemindersReady: config.emailRemindersReady === true };
  } catch {
    return { emailRemindersReady: false };
  }
}
export function getClient() {
  clientPromise ??= (async () => {
    let config;
    try {
      ({ config } = await import('./config.local.js'));
    } catch {
      throw new Error(
        'ยังไม่ได้ตั้งค่าการเชื่อมต่อ: คัดลอก public/js/data/config.example.js เป็น public/js/data/config.local.js แล้วใส่ publishable key',
      );
    }
    validateConfig(config);
    let createClient;
    try {
      ({ createClient } = await import('../vendor/supabase.js'));
    } catch {
      throw new Error('โหลด Supabase ไม่สำเร็จ กรุณาตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วเปิดหน้าใหม่');
    }
    const client = createClient(config.supabaseUrl, config.supabaseKey, {
      global: { fetch: createTimedFetch() },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });
    if (config.privateTextReady !== true) return client;
    const { createPrivateClient } = await import('../privacy/private-client.js');
    return createPrivateClient(client, true);
  })();
  return clientPromise;
}
