import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "../.env") });

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import mysql from "mysql2";
import { GoogleGenerativeAI } from "@google/generative-ai";


// --- Express 應用程式設定 ---
const app = express();
const port = process.env.PORT || 3001;


app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// --- 資料庫連線 ---
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ✅ 查即時天氣資料（OpenWeather）
async function fetchWeather(city = "Taipei") {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&lang=zh_tw&appid=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.weather || !data.weather[0]) {
    console.error("❌ OpenWeather 回傳錯誤：", data);
    return `查不到 ${city} 的天氣資訊，請確認城市名稱是否正確。`;
  }

  return `地點：${data.name}，天氣：${data.weather[0].description}，氣溫：${data.main.temp}°C`;
}

// ✅ 登入
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  const sql = "SELECT * FROM user WHERE email = ? AND password = ?";
  db.query(sql, [email, password], (err, results) => {
    if (err) {
      console.error("Login error:", err);
      return res.status(500).json({ success: false, message: "伺服器錯誤" });
    }

    if (results.length > 0) {
      res.json({ success: true, message: "登入成功" });
    } else {
      res.json({ success: false, message: "帳號或密碼錯誤" });
    }
  });
});

// ✅ 註冊
app.post("/api/register", (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: "請填寫所有欄位" });
  }

  const checkSql = "SELECT * FROM user WHERE email = ?";
  db.query(checkSql, [email], (err, results) => {
    if (err) {
      console.error("Check error:", err);
      return res.status(500).json({ success: false, message: "伺服器錯誤" });
    }

    if (results.length > 0) {
      return res.json({ success: false, message: "此 Email 已註冊" });
    }

    const insertSql = "INSERT INTO user (name, email, password) VALUES (?, ?, ?)";
    db.query(insertSql, [name, email, password], (err, result) => {
      if (err) {
        console.error("Insert error:", err);
        return res.status(500).json({ success: false, message: "註冊失敗" });
      }

      res.json({ success: true, message: "註冊成功！" });
    });
  });
});

// ✅ 地點與日期天氣查詢 API
app.post("/api/weather", async (req, res) => {
  const { city, date } = req.body;
  const apiKey = process.env.OPENWEATHER_API_KEY;

  try {
    const response = await fetch(
      `https://api.openweathermap.org/data/2.5/forecast?q=${city}&appid=${apiKey}&units=metric&lang=zh_tw`
    );
    const data = await response.json();

    if (!data.list || !Array.isArray(data.list)) {
      console.error("❌ OpenWeather 回傳異常：", data);
      return res.status(500).json({ success: false, message: "天氣資料格式錯誤或查無資料" });
    }

    const forecasts = data.list.filter(item => item.dt_txt.startsWith(date));
    if (forecasts.length > 0) {
      const forecast = forecasts[0]; // 可進一步選最接近時間
      res.json({
        success: true,
        temp: forecast.main.temp,
        description: forecast.weather[0].description
      });
    } else {
      res.json({ success: false, message: "找不到該日預報" });
    }
  } catch (err) {
    console.error("Weather API error:", err);
    res.status(500).json({ success: false, message: "API 查詢失敗" });
  }
});

// ✅ 單一場館詳情 API
app.get("/api/venue/:id", (req, res) => {
  const venueId = req.params.id;

  const sql = "SELECT * FROM venues WHERE venues_id = ?";
  db.query(sql, [venueId], (err, results) => {
    if (err) {
      console.error("查詢場館失敗：", err);
      return res.status(500).json({ success: false, message: "資料庫錯誤" });
    }

    if (results.length === 0) {
      return res.json({ success: false, message: "查無資料" });
    }

    const venue = results[0];
    if (venue.image && !venue.image.startsWith("/")) {
      venue.image = "/pic/" + venue.image.replace(/^.*[\\/]/, ""); // 只留檔名
    }

    res.json({ success: true, venue: results[0] });
  });
});



// ✅ AI 喜帖產生器 API
app.post("/generate-wedding", async (req, res) => {
  const { groom, bride, date, place, tone } = req.body;

  const prompt = `
請幫我撰寫一段婚禮喜帖邀請內容，語氣為「${tone}」，包含以下資訊：

- 新人：${groom}與${bride}
- 日期：${date}
- 地點：${place}

文字風格要符合語氣，加入誠摯邀請語。
`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const reply = result.response.candidates[0].content.parts[0].text;

    res.json({ reply });
  } catch (error) {
    console.error("❌ Gemini wedding API error:", error);
    res.status(500).json({ error: "喜帖產生失敗，請稍後再試。" });
  }
});

// ✅ 接收 RSVP 回覆資料
app.post("/api/rsvp", (req, res) => {
  const { name, attendance, guests, contact, notes } = req.body;

  console.log("📥 收到 RSVP:", req.body); // ✅ 加上這一行幫助 debug

  if (!name || !attendance) {
    return res.status(400).json({ success: false, message: "缺少必要欄位" });
  }

  const sql = `
    INSERT INTO rsvp (name, attendance, guests, contact, notes)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.query(sql, [name, attendance, guests || 0, contact || '', notes || ''], (err, result) => {
    if (err) {
      console.error("❌ RSVP 寫入資料庫失敗：", err);
      return res.status(500).json({ success: false, message: "資料儲存失敗" });
    }

    res.json({ success: true, message: "RSVP 回覆已儲存成功" });
  });
});

// ✅ 加在 index.js 裡面
app.get("/api/records", (req, res) => {
  const sql = "SELECT * FROM rsvp ORDER BY rsvp_id DESC";

  db.query(sql, (err, results) => {
    if (err) {
      console.error("❌ 查詢記錄失敗：", err);
      return res.status(500).json({ success: false, message: "資料庫錯誤" });
    }

    res.json({ success: true, data: results });
  });
});

import multer from "multer";
import csv from "csv-parser";
import fs from "fs";

const upload = multer({ dest: "uploads/" });

// ✅ 匯入 CSV 儲存至 guest 資料庫
app.post("/api/import-guests", upload.single("csvFile"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "未收到檔案" });

  const filePath = req.file.path;
  const guests = [];

  fs.createReadStream(filePath)
    .pipe(csv(["name", "email", "relation", "interest"]))
    .on("data", (row) => {
      guests.push(row);
    })
    .on("end", () => {
      fs.unlinkSync(filePath); // 移除暫存檔

      const sql = "INSERT INTO guest (name, email, relation, interest) VALUES ?";
      const values = guests.map(g => [g.name, g.email, g.relation, g.interest]);

      db.query(sql, [values], (err, result) => {
        if (err) {
          console.error("❌ 匯入失敗：", err);
          return res.status(500).json({ success: false, message: "寫入資料庫失敗" });
        }
        res.json({ success: true, message: "匯入成功", count: result.affectedRows });
      });
    });
});

// ✅ 撈取 guest 資料
app.get("/api/guests", (req, res) => {
  db.query("SELECT * FROM guest ORDER BY guest_id DESC", (err, results) => {
    if (err) {
      console.error("❌ guest 查詢錯誤：", err);
      return res.status(500).json({ success: false, message: "資料庫錯誤" });
    }
    res.json({ success: true, data: results });
  });
});


// ✅ 啟動伺服器
app.listen(port, () => {
  console.log(`🤖 Gemini機器人打開摟 at http://localhost:${port}`);
});
