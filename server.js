// TIMESYNC - Backend Server (using Groq) - Fixed time parsing
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const fs = require("fs");
const { google } = require("googleapis");
const Groq = require("groq-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static("public"));
app.use(session({
  secret: process.env.SESSION_SECRET || "timesync_secret",
  resave: false,
  saveUninitialized: false,
}));

const DATA_FILE = "data.json";

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { timetables: { normal: null, training: null, exam: null }, tokens: null };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Fix times like "1:20" → "13:20" (AI sometimes returns PM times in 12hr format)
function fixTime(time) {
  if (!time) return time;
  const [h, m] = time.split(":").map(Number);
  if (h >= 1 && h <= 6) {
    return `${h + 12}:${String(m).padStart(2, "0")}`;
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

app.get("/api/status", (req, res) => {
  const data = loadData();
  res.json({
    googleConnected: !!data.tokens,
    timetables: {
      normal: !!data.timetables.normal,
      training: !!data.timetables.training,
      exam: !!data.timetables.exam,
    },
  });
});

app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    const data = loadData();
    data.tokens = tokens;
    saveData(data);
    res.redirect("/?connected=true");
  } catch (err) {
    console.error("Google auth error:", err);
    res.redirect("/?error=auth_failed");
  }
});

app.post("/api/upload/:type", upload.single("image"), async (req, res) => {
  const { type } = req.params;
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });

  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = req.file.mimetype;

    let prompt = "";
    if (type === "exam") {
      prompt = `Look at this exam timetable image and extract all exam details. Return ONLY a JSON array with no extra text, no markdown, no backticks:
[{"subject":"Mathematics","date":"2026-03-20","startTime":"09:00","endTime":"12:00","venue":"Hall A"}]
Use date format YYYY-MM-DD and time format HH:MM in 24-hour format. If venue not shown use "".`;
    } else {
      prompt = `Look at this ${type === "normal" ? "regular class" : "training day"} timetable image and extract all classes. Return ONLY a JSON array with no extra text, no markdown, no backticks:
[{"subject":"Mathematics","day":"Monday","startTime":"09:00","endTime":"10:00","venue":"Room 101"}]
Use full day names (Monday, Tuesday etc) and HH:MM time format in 24-hour format. For example 1:20 PM = 13:20. If venue not shown use "".`;
    }

    const result = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            { type: "text", text: prompt }
          ]
        }
      ],
      max_tokens: 2000,
    });

    const responseText = result.choices[0].message.content.trim();
    console.log("Groq response:", responseText);

    let schedule;
    try {
      const cleaned = responseText.replace(/```json\n?|\n?```/g, "").trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found");
      schedule = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error("Failed to parse response:", responseText);
      return res.status(500).json({ error: "Could not read the timetable image. Please try a clearer image." });
    }

    const data = loadData();
    const previous = data.timetables[type];
    const changes = detectChanges(previous, schedule, type);
    data.timetables[type] = schedule;
    saveData(data);
    fs.unlinkSync(req.file.path);

    res.json({ success: true, schedule, changes, isUpdate: !!previous });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Something went wrong: " + err.message });
  }
});

function detectChanges(oldSchedule, newSchedule, type) {
  if (!oldSchedule) return { added: newSchedule, removed: [], modified: [] };
  const added = [];
  const removed = [];
  for (const newItem of newSchedule) {
    const key = type === "exam" ? newItem.date + newItem.subject : newItem.day + newItem.startTime;
    const found = oldSchedule.find(o => (type === "exam" ? o.date + o.subject : o.day + o.startTime) === key);
    if (!found) added.push(newItem);
  }
  for (const oldItem of oldSchedule) {
    const key = type === "exam" ? oldItem.date + oldItem.subject : oldItem.day + oldItem.startTime;
    const found = newSchedule.find(n => (type === "exam" ? n.date + n.subject : n.day + n.startTime) === key);
    if (!found) removed.push(oldItem);
  }
  return { added, removed, modified: [] };
}

app.post("/api/sync", async (req, res) => {
  const { type, weekStart } = req.body;
  const data = loadData();
  if (!data.tokens) return res.status(401).json({ error: "Please connect Google Calendar first" });
  if (!data.timetables[type]) return res.status(400).json({ error: `No ${type} timetable uploaded yet` });

  try {
    oauth2Client.setCredentials(data.tokens);
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const schedule = data.timetables[type];
    const createdEvents = [];
    const skipped = [];

    if (type === "exam") {
      for (const item of schedule) {
        const startTime = fixTime(item.startTime);
        const endTime = fixTime(item.endTime);

        if (endTime <= startTime) {
          console.log(`Skipping ${item.subject} - invalid time range`);
          skipped.push(item.subject);
          continue;
        }

        const event = {
          summary: `📝 EXAM: ${item.subject}`,
          location: item.venue || "",
          start: { dateTime: `${item.date}T${startTime}:00`, timeZone: "Asia/Kolkata" },
          end:   { dateTime: `${item.date}T${endTime}:00`,   timeZone: "Asia/Kolkata" },
          colorId: "11",
        };
        const result = await calendar.events.insert({ calendarId: "primary", requestBody: event });
        createdEvents.push(result.data.summary);
      }
    } else {
      const dayMap = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5, Sunday: 6 };
      const weekStartDate = new Date(weekStart);

      for (const item of schedule) {
        const startTime = fixTime(item.startTime);
        const endTime = fixTime(item.endTime);

        if (endTime <= startTime) {
          console.log(`Skipping ${item.subject} - invalid time range`);
          skipped.push(item.subject);
          continue;
        }

        const dayOffset = dayMap[item.day] ?? 0;
        const eventDate = new Date(weekStartDate);
        eventDate.setDate(weekStartDate.getDate() + dayOffset);
        const dateStr = eventDate.toISOString().split("T")[0];

        const event = {
          summary: `${type === "training" ? "🏃" : "📚"} ${item.subject}`,
          location: item.venue || "",
          start: { dateTime: `${dateStr}T${startTime}:00`, timeZone: "Asia/Kolkata" },
          end:   { dateTime: `${dateStr}T${endTime}:00`,   timeZone: "Asia/Kolkata" },
          colorId: type === "training" ? "6" : "1",
        };
        const result = await calendar.events.insert({ calendarId: "primary", requestBody: event });
        createdEvents.push(result.data.summary);
      }
    }

    if (oauth2Client.credentials) { data.tokens = oauth2Client.credentials; saveData(data); }
    res.json({ 
      success: true, 
      created: createdEvents.length, 
      events: createdEvents,
      skipped: skipped
    });
  } catch (err) {
    console.error("Sync error:", err);
    res.status(500).json({ error: "Calendar sync failed: " + err.message });
  }
});

// --- Add class manually ---
app.post("/api/add-class", (req, res) => {
  const { type, newClass } = req.body;
  if (!type || !newClass) return res.status(400).json({ error: "Missing data" });
  const data = loadData();
  if (!data.timetables[type]) data.timetables[type] = [];
  data.timetables[type].push(newClass);
  saveData(data);
  res.json({ success: true });
});

app.get("/api/timetables", (req, res) => {
  const data = loadData();
  res.json(data.timetables);
});

app.get("/api/exam-dates", (req, res) => {
  const data = loadData();
  res.json((data.timetables.exam || []).map(e => e.date));
});

app.listen(PORT, () => {
  console.log(`✅ TimeSync is running at http://localhost:${PORT}`);
  console.log(`📅 Open this URL in your browser to use the app`);
});
