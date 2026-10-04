-- =========================================================
-- D1 schema สำหรับระบบติดตามผลการเรียนรู้ "รู้ทันมิจฉาชีพ"
-- วิธีใช้: Cloudflare dashboard → Workers & Pages → D1 →
--   เลือกฐานข้อมูล scam_awareness_db → แท็บ Console →
--   วางไฟล์นี้ทั้งไฟล์ → Execute (รันซ้ำได้ ไม่ลบข้อมูลเดิม)
-- =========================================================

-- 1 แถว = การเล่น 1 รอบ (เล่นซ้ำ = แถวใหม่ รหัส นศ. เดิม)
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,      -- UUID สร้างฝั่งเบราว์เซอร์
  created_at       INTEGER NOT NULL,      -- epoch ms (นาฬิกาเซิร์ฟเวอร์)
  updated_at       INTEGER NOT NULL,
  student_id       TEXT,                  -- รหัสนักศึกษา (เก็บเฉพาะผู้ที่ยินยอม)
  class_code       TEXT,                  -- จากลิงก์ ?c=รหัสห้อง ใช้กรองรายกลุ่ม
  consent_version  TEXT,                  -- เวอร์ชันข้อความยินยอมที่ผู้ใช้กดยอมรับ
  device           TEXT,                  -- ios / android / desktop
  browser          TEXT,                  -- safari / chrome / other
  status           TEXT,                  -- in_progress / completed
  last_screen      TEXT,                  -- หน้าจอล่าสุด (ดูว่าหลุดตรงไหน)
  lesson_ms        INTEGER,               -- เวลาอ่านบทเรียน
  quiz_active_ms   INTEGER,               -- เวลาทำควิซ (ไม่รวมช่วงสายโทรเข้า)
  score            INTEGER,
  total            INTEGER,
  call_trigger_q   INTEGER,               -- สายเข้าระหว่างข้อที่ (เริ่ม 1)
  call_forced      INTEGER,               -- 1 = สายถูกบังคับให้เกิดก่อนดูผล
  ring_ms          INTEGER,               -- เวลาที่สายดังก่อนตัดสินใจ
  call_outcome     TEXT,                  -- declined / missed / hungup / transferred
  call_duration_ms INTEGER,               -- กดรับสาย → จบสาย
  call_turns       INTEGER,               -- จำนวนครั้งที่ผู้ใช้พูด
  call_end_reason  TEXT,                  -- user / mic_error / no_speech / ai_error
  mic_error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_class   ON sessions(class_code);

-- คำตอบรายข้อ (ใช้ทำ item analysis)
CREATE TABLE IF NOT EXISTS answers (
  session_id TEXT NOT NULL,
  q_index    INTEGER NOT NULL,            -- เริ่ม 0
  selected   INTEGER,
  correct    INTEGER,
  time_ms    INTEGER,                     -- เวลาคิดก่อนเลือกคำตอบ
  PRIMARY KEY (session_id, q_index)
);

-- บทสนทนาในสายจำลอง (ข้อความที่ถอดจากเสียง ไม่เก็บไฟล์เสียง)
CREATE TABLE IF NOT EXISTS call_turns (
  session_id TEXT NOT NULL,
  turn_no    INTEGER NOT NULL,
  role       TEXT NOT NULL,               -- user / assistant
  text       TEXT,
  t_ms       INTEGER,                     -- เวลานับจากกดรับสาย
  PRIMARY KEY (session_id, turn_no)
);

-- ข้อมูลนักศึกษาจากฐานข้อมูลมหาวิทยาลัย (เติมภายหลัง เมื่อได้รับอนุญาต)
-- dashboard จะ JOIN ตารางนี้เพื่อแยกผลตามสำนักวิชา/ชั้นปี อัตโนมัติ
CREATE TABLE IF NOT EXISTS student_directory (
  student_id TEXT PRIMARY KEY,
  school     TEXT,                        -- สำนักวิชา
  program    TEXT,                        -- หลักสูตร
  year       INTEGER                      -- ชั้นปี
);
