# จัดหนี้ — เว็บไซต์

ชุดไฟล์ static สำหรับรันเว็บไซต์ ใช้ Supabase เดิมเป็น backend ไม่มี server, SQL, ข้อมูลผู้ใช้, รหัสผ่าน, service-role key, ไฟล์ทดสอบ หรือรายงานในเครื่องใน repository นี้

## การรัน

ให้บริการไฟล์จากโฟลเดอร์รากด้วย static web server แล้วเปิด index.html ต้องใช้ HTTP/HTTPS ไม่ใช่ file:// สำหรับ Vercel ให้ใช้โฟลเดอร์รากเป็น output และไม่ต้อง build หรือติดตั้ง dependencies; vercel.json มี security headers อยู่แล้ว ตรวจ headers จริงหลัง deploy โฮสต์อื่นต้องตั้ง headers เทียบเท่าด้วยตนเอง

js/data/config.local.js มีเฉพาะ Supabase URL และ publishable key ที่เบราว์เซอร์ต้องใช้ คีย์นี้เป็น public ไม่ใช่รหัสหลังบ้าน ห้ามแทนด้วย secret/service-role key ความปลอดภัยของข้อมูลต้องบังคับด้วย RLS, grants และการตรวจเจ้าของใน RPC ฝั่งฐานข้อมูล ตั้ง Auth redirect URLs ให้ตรงกับโดเมน HTTPS จริง

## ผลตรวจ 18 พฤศจิกายน 2026

ทดสอบในเครื่องผ่าน 150 ข้อ; build และ release scan ผ่าน ไม่พบ findings ตามตัวตรวจที่ใช้ ไม่รวมการตรวจสิทธิ์ฐานข้อมูลจริงระหว่างบัญชี A/B, worker grants, backup/restore และ production domain จึงยังไม่รับรองความพร้อมเปิดรับผู้ใช้ทั่วไป อีเมลแจ้งเตือนและ private-text feature ยังปิดอยู่

การ push code ไม่ได้เปิด GitHub Pages หรือ deploy เว็บไซต์โดยอัตโนมัติ
