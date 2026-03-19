document.addEventListener("DOMContentLoaded", async () => {
  showTodayDate();
  setDefaultWeekStart();
  await checkStatus();
  await checkExamDay();
});

function showTodayDate() {
  const now = new Date();
  document.getElementById("today-day").textContent = now.toLocaleDateString("en-IN", { weekday: "long" });
  document.getElementById("today-date").textContent = now.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function setDefaultWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  document.getElementById("week-start").value = monday.toISOString().split("T")[0];
}

async function checkStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    const statusEl = document.getElementById("google-status");
    const textEl = document.getElementById("google-status-text");
    const connectBtn = document.getElementById("connect-btn");
    if (data.googleConnected) {
      statusEl.classList.add("connected");
      textEl.textContent = "Google Calendar Connected ✓";
      connectBtn.textContent = "✓ Connected";
      connectBtn.style.background = "rgba(109,250,170,0.15)";
      connectBtn.style.color = "#6dfaaa";
      connectBtn.style.border = "1px solid rgba(109,250,170,0.3)";
    }
    if (data.timetables.normal) markCardUploaded("normal");
    if (data.timetables.training) markCardUploaded("training");
    if (data.timetables.exam) markCardUploaded("exam");
    await loadAndShowTimetables();
  } catch (err) { console.error("Status check failed:", err); }
}

async function checkExamDay() {
  try {
    const res = await fetch("/api/exam-dates");
    const examDates = await res.json();
    const today = new Date().toISOString().split("T")[0];
    if (examDates.includes(today)) {
      document.getElementById("exam-alert").classList.add("show");
      document.getElementById("sync-controls").style.display = "none";
    }
  } catch (err) { console.error("Exam date check failed:", err); }
}

async function uploadTimetable(type, inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  const statusEl = document.getElementById("status-" + type);
  statusEl.className = "upload-status loading";
  statusEl.innerHTML = '<span class="spinner"></span> Reading your timetable with AI...';
  const formData = new FormData();
  formData.append("image", file);
  try {
    const res = await fetch("/api/upload/" + type, { method: "POST", body: formData });
    const data = await res.json();
    if (data.success) {
      const count = data.schedule.length;
      let msg = "✅ Found " + count + " " + (type === "exam" ? "exams" : "classes") + "!";
      if (data.isUpdate && data.changes) {
        const a = data.changes.added ? data.changes.added.length : 0;
        const r = data.changes.removed ? data.changes.removed.length : 0;
        if (a > 0 || r > 0) msg += " (" + a + " added, " + r + " removed)";
        else msg += " No changes detected.";
      }
      statusEl.className = "upload-status success";
      statusEl.textContent = msg;
      markCardUploaded(type);
      await loadAndShowTimetables();
      if (type === "exam") await autoSyncExams();
    } else {
      statusEl.className = "upload-status error";
      statusEl.textContent = "❌ " + (data.error || "Upload failed");
    }
  } catch (err) {
    statusEl.className = "upload-status error";
    statusEl.textContent = "❌ Network error. Is the server running?";
  }
}

async function autoSyncExams() {
  const statusEl = document.getElementById("status-exam");
  statusEl.textContent += " Syncing to Google Calendar...";
  try {
    const res = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "exam", weekStart: null }) });
    const data = await res.json();
    if (data.success) statusEl.textContent += " 📅 " + data.created + " exam events added!";
  } catch (err) {}
}

function markCardUploaded(type) {
  const card = document.getElementById("card-" + type);
  if (card) card.classList.add("uploaded");
}

async function syncToCalendar() {
  const type = document.getElementById("schedule-type").value;
  const weekStart = document.getElementById("week-start").value;
  const resultEl = document.getElementById("sync-result");
  const btn = document.getElementById("sync-btn");
  if (!weekStart) {
    resultEl.className = "error"; resultEl.style.display = "block";
    resultEl.textContent = "❌ Please pick the Monday of the week you want to sync."; return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Syncing...';
  resultEl.style.display = "none";
  try {
    const res = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, weekStart }) });
    const data = await res.json();
    if (data.success) {
      resultEl.className = "sync-result success"; resultEl.style.display = "block";
      resultEl.innerHTML = "✅ Done! Added " + data.created + " events to Google Calendar.<br/><small style='opacity:0.7'>Events: " + data.events.slice(0,5).join(", ") + (data.created > 5 ? "..." : "") + "</small>";
      if (data.skipped && data.skipped.length) resultEl.innerHTML += "<br/><small style='color:var(--orange)'>⚠️ Skipped: " + data.skipped.join(", ") + "</small>";
    } else {
      resultEl.className = "sync-result error"; resultEl.style.display = "block";
      resultEl.textContent = "❌ " + data.error;
    }
  } catch (err) {
    resultEl.className = "sync-result error"; resultEl.style.display = "block";
    resultEl.textContent = "❌ Network error.";
  }
  btn.disabled = false; btn.textContent = "Sync to Calendar";
}

async function loadAndShowTimetables() {
  try {
    const res = await fetch("/api/timetables");
    const timetables = await res.json();
    renderTable("normal", timetables.normal, ["Subject", "Day", "Start", "End", "Venue"]);
    renderTable("training", timetables.training, ["Subject", "Day", "Start", "End", "Venue"]);
    renderTable("exam", timetables.exam, ["Subject", "Date", "Start", "End", "Venue"]);
  } catch (err) { console.error("Failed to load timetables:", err); }
}

function renderTable(type, data, headers) {
  const container = document.getElementById("table-" + type);
  if (!container) return;
  if (!data || data.length === 0) {
    container.innerHTML = "<div class='no-data'>No " + type + " timetable uploaded yet 📭</div>"; return;
  }
  let html = "<table class='schedule-table'><thead><tr>" + headers.map(function(h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>";
  for (var i = 0; i < data.length; i++) {
    var item = data[i];
    if (type === "exam") {
      html += "<tr><td>" + item.subject + "</td><td>" + item.date + "</td><td>" + item.startTime + "</td><td>" + item.endTime + "</td><td>" + (item.venue || "—") + "</td></tr>";
    } else {
      html += "<tr><td>" + item.subject + "</td><td>" + item.day + "</td><td>" + item.startTime + "</td><td>" + item.endTime + "</td><td>" + (item.venue || "—") + "</td></tr>";
    }
  }
  html += "</tbody></table>";
  container.innerHTML = html;
}

function showTab(type, e) {
  ["normal", "training", "exam"].forEach(function(t) { document.getElementById("table-" + t).style.display = "none"; });
  document.querySelectorAll(".tab-btn").forEach(function(btn) { btn.classList.remove("active"); });
  document.getElementById("table-" + type).style.display = "block";
  if (e && e.target) e.target.classList.add("active");
}

function toggleDateDay() {
  var isExam = document.getElementById("manual-type").value === "exam";
  document.getElementById("manual-day-wrap").style.display = isExam ? "none" : "block";
  document.getElementById("manual-date-wrap").style.display = isExam ? "block" : "none";
}

async function addClassManually() {
  var type = document.getElementById("manual-type").value;
  var subject = document.getElementById("manual-subject").value.trim();
  var startTime = document.getElementById("manual-start").value;
  var endTime = document.getElementById("manual-end").value;
  var venue = document.getElementById("manual-venue").value.trim();
  var resultEl = document.getElementById("manual-result");

  if (!subject || !startTime || !endTime) {
    resultEl.style.color = "var(--accent2)";
    resultEl.textContent = "❌ Please fill in subject, start time and end time!";
    return;
  }

  var newClass = {};
  if (type === "exam") {
    var date = document.getElementById("manual-date").value;
    if (!date) { resultEl.style.color = "var(--accent2)"; resultEl.textContent = "❌ Please pick an exam date!"; return; }
    newClass = { subject: subject, date: date, startTime: startTime, endTime: endTime, venue: venue };
  } else {
    var day = document.getElementById("manual-day").value;
    newClass = { subject: subject, day: day, startTime: startTime, endTime: endTime, venue: venue };
  }

  try {
    var res = await fetch("/api/add-class", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: type, newClass: newClass }) });
    var data = await res.json();
    if (data.success) {
      resultEl.style.color = "var(--green)";
      resultEl.textContent = "✅ " + subject + " added to " + type + " timetable!";
      document.getElementById("manual-subject").value = "";
      document.getElementById("manual-start").value = "";
      document.getElementById("manual-end").value = "";
      document.getElementById("manual-venue").value = "";
      await loadAndShowTimetables();
    } else {
      resultEl.style.color = "var(--accent2)";
      resultEl.textContent = "❌ " + data.error;
    }
  } catch (err) {
    resultEl.style.color = "var(--accent2)";
    resultEl.textContent = "❌ Network error.";
  }
}

var urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("connected") === "true") { alert("✅ Google Calendar connected successfully!"); window.history.replaceState({}, "", "/"); }
if (urlParams.get("error") === "auth_failed") { alert("❌ Google login failed. Please try again."); window.history.replaceState({}, "", "/"); }
