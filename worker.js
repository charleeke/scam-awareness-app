/* =========================================================
   Cloudflare Worker — Anthropic API proxy
   ---------------------------------------------------------
   หน้าที่: รับ request จากหน้าเว็บ index.html (ไม่มี API key ติดมา)
   แล้วเติม Anthropic API key (เก็บเป็น secret ฝั่งเซิร์ฟเวอร์) ก่อน
   ส่งต่อไปยัง Anthropic จริง แล้วส่งคำตอบกลับไปให้หน้าเว็บ

   ผู้ใช้ปลายทาง (นักศึกษาที่เล่นแอป) และใครก็ตามที่เปิดดู source
   ของ index.html จะไม่มีทางเห็น API key เลย เพราะคีย์ไม่เคยอยู่ใน
   โค้ดฝั่งเบราว์เซอร์หรือใน GitHub repo แต่อย่างใด

   วิธี deploy (ทำครั้งเดียว ผ่านหน้าเว็บ Cloudflare ไม่ต้องลงโปรแกรม):
   1. สมัคร/ล็อกอิน https://dash.cloudflare.com (ฟรี ไม่ต้องใช้บัตรเครดิต)
   2. เมนูซ้าย เลือก "Workers & Pages" -> "Create" -> "Create Worker"
   3. ตั้งชื่อ เช่น scam-awareness-proxy -> "Deploy" (ปล่อยโค้ด default ไปก่อน)
   4. กด "Edit code" (หรือ "Quick edit") ลบโค้ดเดิมทั้งหมด แล้ววางไฟล์นี้
      ทั้งไฟล์แทน -> กด "Deploy" / "Save and deploy"
   5. กลับไปหน้า Worker -> แท็บ "Settings" -> "Variables and Secrets"
      -> "Add" -> Type: Secret, Name: ANTHROPIC_API_KEY,
      Value: วางคีย์จริงจาก https://console.anthropic.com/settings/keys
      (ขึ้นต้นด้วย sk-ant-api03-) -> Save and deploy
      (แนะนำ: ตั้ง spending limit ต่ำ ๆ ให้คีย์นี้ในหน้า Console ด้วย)
   6. เพิ่มอีกตัวแบบ Type: Text (ไม่ต้อง Secret): Name: ALLOWED_ORIGIN,
      Value: https://charleeke.github.io  (ไม่ต้องมี / ปิดท้าย)
      -> กันไม่ให้เว็บอื่นเรียกใช้ Worker นี้ได้ง่าย ๆ
   7. คัดลอก URL ของ Worker (รูปแบบ https://ชื่อ.บัญชีย่อย.workers.dev)
      ไปวางแทนค่า WORKER_URL ในไฟล์ index.html แล้ว commit ขึ้น GitHub

   หมายเหตุด้านความปลอดภัย: Worker นี้เป็น public endpoint เช่นกัน
   (ใครมี URL ก็เรียกได้) การเช็ค Origin ช่วยกันการเรียกข้ามเว็บแบบ
   ทั่วไปได้ระดับหนึ่งแต่ปลอมได้ไม่ยาก — ตัวป้องกันหลักที่แท้จริงคือ
   การตั้ง spending limit ของ API key ไว้ต่ำ และใช้เฉพาะช่วงสาธิต
   แล้วปิด/ลบ Worker หรือ revoke คีย์หลังใช้งานเสร็จ
   ========================================================= */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403, headers: cors });
    }
    if (!env.ANTHROPIC_API_KEY) {
      return new Response('Server missing ANTHROPIC_API_KEY', { status: 500, headers: cors });
    }

    let bodyText;
    try {
      bodyText = await request.text();
    } catch (e) {
      return new Response('Bad request', { status: 400, headers: cors });
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: bodyText
    });

    const respBody = await upstream.text();
    return new Response(respBody, {
      status: upstream.status,
      headers: { 'content-type': 'application/json', ...cors }
    });
  }
};
