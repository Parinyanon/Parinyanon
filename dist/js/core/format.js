export function bangkokToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export function dateText(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '—';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium' }).format(
        date,
      )
    : '—';
}
// ปัดเพื่อแสดงผลเท่านั้น ไม่ใช้ค่านี้หักหนี้หรือยืนยันยอดชำระ
export function money(value) {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
      : String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return '—';
  const [whole, fraction = ''] = text.split('.');
  let cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  if (Number(fraction[2] ?? 0) >= 5) cents++;
  const grouped = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${(cents % 100n).toString().padStart(2, '0')} บาท`;
}
