// ✅ 完整 index.js（支援匯入CSV + 多功能）
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import mysql from "mysql2";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // ✅ 加上這一行來支援 multipart/form-data
app.use(express.static(path.join(__dirname, "../public")));
app.use('/templates', express.static(path.join(__dirname, 'public/templates')));



// ✅ 資料庫連線
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ✅ 查天氣
async function fetchWeather(city = "Taipei") {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&lang=zh_tw&appid=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.weather || !data.weather[0]) return `查不到 ${city} 的天氣資訊`;
  return `地點：${data.name}，天氣：${data.weather[0].description}，氣溫：${data.main.temp}°C`;
}

// ✅ 使用者登入
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  db.query("SELECT * FROM user WHERE email = ? AND password = ?", [email, password], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "伺服器錯誤" });
    if (results.length > 0) res.json({ success: true, message: "登入成功" });
    else res.json({ success: false, message: "帳號或密碼錯誤" });
  });
});

// ✅ 註冊
app.post("/api/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "請填寫所有欄位" });
  db.query("SELECT * FROM user WHERE email = ?", [email], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "伺服器錯誤" });
    if (results.length > 0) return res.json({ success: false, message: "此 Email 已註冊" });
    db.query("INSERT INTO user (name, email, password) VALUES (?, ?, ?)", [name, email, password], (err2) => {
      if (err2) return res.status(500).json({ success: false, message: "註冊失敗" });
      res.json({ success: true, message: "註冊成功！" });
    });
  });
});

// ✅ 地點天氣查詢
app.post("/api/weather", async (req, res) => {
  const { city, date } = req.body;
  const apiKey = process.env.OPENWEATHER_API_KEY;
  try {
    const response = await fetch(
      `https://api.openweathermap.org/data/2.5/forecast?q=${city}&appid=${apiKey}&units=metric&lang=zh_tw`
    );
    const data = await response.json();
    const forecasts = data.list?.filter(item => item.dt_txt.startsWith(date));
    if (!forecasts || forecasts.length === 0) return res.json({ success: false, message: "找不到該日預報" });
    const forecast = forecasts[0];
    res.json({ success: true, temp: forecast.main.temp, description: forecast.weather[0].description });
  } catch (err) {
    console.error("Weather API error:", err);
    res.status(500).json({ success: false, message: "API 查詢失敗" });
  }
});

// ✅ 場館查詢
app.get("/api/venue/:id", (req, res) => {
  const sql = "SELECT * FROM venues WHERE venues_id = ?";
  db.query(sql, [req.params.id], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "資料庫錯誤" });
    if (results.length === 0) return res.json({ success: false, message: "查無資料" });
    const venue = results[0];
    if (venue.image && !venue.image.startsWith("/")) venue.image = "/pic/" + venue.image.replace(/^.*[\\/]/, "");
    res.json({ success: true, venue });
  });
});

// ✅ AI 喜帖產生
app.post("/api/generate-invitation", async (req, res) => {
  const { groom, bride, date, place, tone } = req.body;

  if (!groom || !bride || !date || !place || !tone) {
    return res.status(400).json({ success: false, message: "缺少必要欄位" });
  }

  const prompt = `
請幫我用溫柔、自然、像在和朋友說話的方式，撰寫一段婚禮喜帖內容。

新郎：${groom}
新娘：${bride}
婚禮日期：${date}
地點：${place}
婚禮風格：${tone}

希望讓收件者感受到邀請誠意與溫馨氛圍，不要太正式。
`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const invitation = result.response.candidates[0].content.parts[0].text;

    // 儲存到 MySQL
    const sql = `INSERT INTO invitations (groom, bride, date, place, tone, content) VALUES (?, ?, ?, ?, ?, ?)`;
    db.query(sql, [groom, bride, date, place, tone, invitation], (err, result) => {
      if (err) {
        console.error("❌ 儲存失敗：", err);
        return res.status(500).json({ success: false, message: "儲存到資料庫失敗" });
      }
      res.json({ success: true, invitation });
    });
  } catch (err) {
    console.error("❌ Gemini 生成失敗：", err);
    res.status(500).json({ success: false, message: "AI 生成錯誤" });
  }
});

// ✅ RSVP 回覆
app.post("/api/rsvp", (req, res) => {
  const { name, attendance, guests, contact, notes } = req.body;
  if (!name || !attendance) return res.status(400).json({ success: false, message: "缺少必要欄位" });
  const sql = "INSERT INTO rsvp (name, attendance, guests, contact, notes) VALUES (?, ?, ?, ?, ?)";
  db.query(sql, [name, attendance, guests || 0, contact || '', notes || ''], (err) => {
    if (err) return res.status(500).json({ success: false, message: "儲存失敗" });
    res.json({ success: true, message: "回覆成功" });
  });
});

// ✅ RSVP 查詢
app.get("/api/records", (req, res) => {
  db.query("SELECT * FROM rsvp ORDER BY rsvp_id DESC", (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "資料庫錯誤" });
    res.json({ success: true, data: results });
  });
});

// ✅ CSV 上傳與匯入 guest
const upload = multer({ dest: "uploads/" });
app.post("/api/import-guests", upload.single("csvFile"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "未收到檔案" });

  const filePath = req.file.path;
  const guests = [];

  let rowIndex = 0;

  fs.createReadStream(filePath)
    .pipe(csv(["name", "email", "relation", "interest"]))
    .on("data", (row) => {
      // ✅ 跳過第一列（即使有 BOM）
      if (rowIndex === 0 && (
          row.name.trim().toLowerCase() === "name" ||
          row.name.trim().toLowerCase().includes("姓名")
        )) {
        rowIndex++;
        return;
      }

      // ✅ 檢查必要欄位
      if (row.name && row.email) {
        guests.push({
          name: row.name.trim(),
          email: row.email.trim(),
          relation: row.relation?.trim() || "",
          interest: row.interest?.trim() || ""
        });
      }

      rowIndex++;
    })
    .on("end", () => {
      fs.unlinkSync(filePath); // ✅ 刪掉暫存檔

      if (guests.length === 0) {
        return res.status(400).json({ success: false, message: "無有效資料" });
      }

      const sql = "INSERT INTO guest (name, email, relation, interest) VALUES ?";
      const values = guests.map(g => [g.name, g.email, g.relation, g.interest]);

      db.query(sql, [values], (err, result) => {
        if (err) {
          console.error("❌ 匯入錯誤：", err);
          return res.status(500).json({ success: false, message: "資料庫寫入錯誤" });
        }
        res.json({ success: true, message: "匯入成功", count: result.affectedRows });
      });
    });
});

// ✅ 刪除單筆 guest 資料
app.delete("/api/guest/:id", (req, res) => {
  const guestId = req.params.id;
  db.query("DELETE FROM guest WHERE guest_id = ?", [guestId], (err, result) => {
    if (err) {
      console.error("❌ 刪除失敗：", err);
      return res.status(500).json({ success: false, message: "資料庫錯誤" });
    }
    res.json({ success: true, message: "刪除成功" });
  });
});



// ✅ 撈 guest 資料
app.get("/api/guests", (req, res) => {
  db.query("SELECT * FROM guest ORDER BY guest_id DESC", (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "資料庫錯誤" });
    res.json({ success: true, data: results });
  });
});

// ✅ 節目表
app.post("/api/generate-program", async (req, res) => {
  const { style } = req.body;
  const sql = "SELECT interest FROM guest";

  db.query(sql, async (err, results) => {
    if (err) return res.status(500).json({ success: false, message: "資料庫錯誤" });

    const interestSet = new Set();
    results.forEach(row => {
      row.interest?.split(",").map(i => i.trim()).forEach(i => interestSet.add(i));
    });

    const interests = [...interestSet].join("、");

 const prompt = `
請根據以下婚禮風格與賓客興趣，幫我生成一份對應的婚禮節目流程表，使用時間軸格式。

婚禮風格：${style}
賓客興趣：${interests}

請務必以 13:00 開始、每半小時一個節目為主，並展現風格與興趣的結合，語氣溫馨自然。
⚠️ 請用 HTML <table> 產出節目表，時間與節目分成兩欄，文字不要超過寬度。
`;


    try {
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent(prompt);
      const reply = result.response.candidates[0].content.parts[0].text;

      res.json({ success: true, program: reply });
    } catch (err) {
      console.error("❌ Gemini 失敗：", err);
      res.status(500).json({ success: false, message: "AI 生成錯誤" });
    }
  });
});


// ✅ 啟動伺服器
app.listen(port, () => {
  console.log(`🤖 Gemini機器人打開摟 at http://localhost:${port}`);
});
