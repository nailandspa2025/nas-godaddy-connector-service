/** Kiểm tra cấu hình: lấy access token rồi liệt kê store/device của business. */
import { getAccessToken } from '../src/poynt/auth';
import { envMerchant, getStores } from '../src/poynt/service';

(async () => {
  const token = await getAccessToken();
  console.log('Access token OK:', token.slice(0, 24) + '…');
  const stores: any[] = await getStores(envMerchant());
  for (const s of stores || []) {
    console.log(`store ${s.id} (${s.displayName || s.name}) status=${s.status}`);
    for (const d of s.storeDevices || []) console.log(`  device ${d.deviceId} status=${d.status}`);
  }
})().catch((e) => {
  console.error(e.message, e.details ?? '');
  process.exit(1);
});
