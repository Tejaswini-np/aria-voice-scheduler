/**
 * Voice Scheduling Agent — Server
 * Stack: OpenAI Realtime API (voice) + Google Calendar API
 * Author: Tejaswini Popuri
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { google } from "googleapis";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── Google Calendar OAuth2 Setup ──────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/auth/callback"
);

// If a refresh token is stored, set credentials immediately
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
}

const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// ─── Auth Routes ────────────────────────────────────────────────────────────
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log("✅ Google OAuth tokens received");
    console.log("🔑 Refresh token:", tokens.refresh_token);
    res.send(`
      <html><body style="font-family:monospace;padding:40px;background:#0a0a0a;color:#00ff88">
        <h2>✅ Google Calendar Connected!</h2>
        <p>Add this to your .env file:</p>
        <pre style="background:#111;padding:16px;border-radius:8px">GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}</pre>
        <a href="/" style="color:#00ff88">← Back to Agent</a>
      </body></html>
    `);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("OAuth failed: " + err.message);
  }
});

// ─── Calendar Event Creation ─────────────────────────────────────────────────
async function createCalendarEvent({ name, date, time, title }) {
  // Parse date/time into ISO format
  const dateTimeStr = `${date}T${time}:00`;
  const startDateTime = new Date(dateTimeStr);
  if (isNaN(startDateTime.getTime())) {
    throw new Error(`Invalid date/time: ${dateTimeStr}`);
  }
  const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // +1 hour

  const eventTitle = title || `Meeting with ${name}`;

  const event = {
    summary: eventTitle,
    description: `Scheduled via Voice Scheduling Agent\nBooked by: ${name}`,
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: "America/Chicago", // Dallas/Plano timezone
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: "America/Chicago",
    },
    attendees: [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 15 },
        { method: "email", minutes: 60 },
      ],
    },
  };

  const response = await calendar.events.insert({
    calendarId: "primary",
    resource: event,
    sendUpdates: "none",
  });

  return {
    id: response.data.id,
    link: response.data.htmlLink,
    summary: response.data.summary,
    start: response.data.start.dateTime,
    end: response.data.end.dateTime,
  };
}

// ─── REST endpoint for manual event creation (used by frontend fallback) ────
app.post("/api/create-event", async (req, res) => {
  try {
    const { name, date, time, title } = req.body;
    if (!name || !date || !time) {
      return res.status(400).json({ error: "name, date, and time are required" });
    }
    const event = await createCalendarEvent({ name, date, time, title });
    res.json({ success: true, event });
  } catch (err) {
    console.error("Calendar error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    calendarConnected: !!process.env.GOOGLE_REFRESH_TOKEN,
    openaiConfigured: !!process.env.OPENAI_API_KEY,
  });
});

// ─── OpenAI Realtime WebSocket Proxy ─────────────────────────────────────────
// The browser connects here; we proxy to OpenAI and inject the system prompt + tools
wss.on("connection", (clientWs, req) => {
  console.log("🎙️  Client connected");

  const OPENAI_WS_URL =
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

  let openaiWs = null;
  let sessionReady = false;
  const pendingMessages = [];

  // Connect to OpenAI Realtime
  openaiWs = new WebSocket(OPENAI_WS_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");

    // Configure the session with our scheduling assistant persona
    const sessionConfig = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: buildSystemPrompt(),
        voice: "alloy",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
        },
        tools: getTools(),
        tool_choice: "auto",
        temperature: 0.7,
        max_response_output_tokens: 512,
      },
    };

    openaiWs.send(JSON.stringify(sessionConfig));

    // Drain any queued messages
    pendingMessages.forEach((m) => openaiWs.send(m));
    pendingMessages.length = 0;
    sessionReady = true;
  });

  // Relay OpenAI → Client, but intercept function calls
  openaiWs.on("message", async (data) => {
    const msg = JSON.parse(data.toString());

    // Handle tool calls from the model
    if (msg.type === "response.function_call_arguments.done") {
      await handleFunctionCall(msg, openaiWs, clientWs);
      return; // Don't forward raw tool call to client
    }

    // Forward everything else to the browser client
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: "error", message: err.message }));
    }
  });

  openaiWs.on("close", () => {
    console.log("OpenAI WS closed");
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  // Relay Client → OpenAI
  clientWs.on("message", (data) => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(data.toString());
    } else {
      pendingMessages.push(data.toString());
    }
  });

  clientWs.on("close", () => {
    console.log("Client disconnected");
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

// ─── Function call handler ────────────────────────────────────────────────────
async function handleFunctionCall(msg, openaiWs, clientWs) {
  const { call_id, name, arguments: argsStr } = msg;
  let args;
  try {
    args = JSON.parse(argsStr);
  } catch {
    args = {};
  }

  console.log(`🔧 Tool call: ${name}`, args);

  let result;

  if (name === "create_calendar_event") {
    try {
      const event = await createCalendarEvent(args);
      result = {
        success: true,
        message: `Event "${event.summary}" created successfully!`,
        event_link: event.link,
        event_id: event.id,
        start_time: event.start,
      };
      // Also notify the frontend UI
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: "event_created",
            event,
            details: args,
          })
        );
      }
    } catch (err) {
      console.error("Calendar creation failed:", err.message);
      result = { success: false, error: err.message };
    }
  } else {
    result = { error: "Unknown function" };
  }

  // Send tool result back to OpenAI
  openaiWs.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id,
        output: JSON.stringify(result),
      },
    })
  );

  // Trigger model to continue responding
  openaiWs.send(JSON.stringify({ type: "response.create" }));
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    dateStyle: "full",
    timeStyle: "short",
  });

  return `You are ARIA — Automated Real-time Intelligence Assistant — a warm, professional voice scheduling assistant.

Today's date and time: ${now} (Central Time, Dallas TX).

Your ONLY job is to help users schedule meetings on their Google Calendar. Follow this exact flow:

1. GREET: Warmly greet the user and introduce yourself as ARIA.
2. NAME: Ask for their name.
3. DATE: Ask what date they'd like to schedule for. Accept natural language like "tomorrow", "next Monday", "March 25th". Always confirm by repeating the full date back (e.g., "Got it — Tuesday, March 25th").
4. TIME: Ask for their preferred time. Accept natural language like "2pm", "3:30 in the afternoon". Confirm it back.
5. TITLE (optional): Ask if they have a meeting title or topic. If they say "no" or "skip", use "Meeting with [name]".
6. CONFIRM: Summarize all details clearly: "So I'll schedule '[title]' on [day], [date] at [time] Central Time. Does that sound right?"
7. CREATE: Once confirmed, call the create_calendar_event function with the parsed details.
8. WRAP UP: After the event is created, tell them it's on their calendar and wish them well. Offer to schedule another if they'd like.

IMPORTANT RULES:
- Be conversational, warm, and concise. No long monologues.
- Always convert relative dates (tomorrow, next Monday) to actual YYYY-MM-DD format before calling the function.
- Always use 24-hour time format (HH:MM) when calling the function.
- If the user gives you ambiguous info, ask a clarifying question.
- Do NOT make up information. Ask if unsure.
- If calendar creation fails, apologize and offer to try again.
- Keep responses SHORT — you're speaking, not writing.`;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
function getTools() {
  return [
    {
      type: "function",
      name: "create_calendar_event",
      description:
        "Creates a Google Calendar event after collecting and confirming all details with the user.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Full name of the person booking the meeting",
          },
          date: {
            type: "string",
            description: "Event date in YYYY-MM-DD format",
          },
          time: {
            type: "string",
            description: "Event start time in HH:MM (24-hour) format",
          },
          title: {
            type: "string",
            description:
              "Optional meeting title. Defaults to 'Meeting with [name]' if not provided.",
          },
        },
        required: ["name", "date", "time"],
      },
    },
  ];
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Voice Scheduling Agent running at http://localhost:${PORT}`);
  console.log(`📅 Calendar auth: http://localhost:${PORT}/auth/google`);
  console.log(
    `🔑 OpenAI key: ${process.env.OPENAI_API_KEY ? "✅ set" : "❌ missing"}`
  );
  console.log(
    `📆 Google Calendar: ${process.env.GOOGLE_REFRESH_TOKEN ? "✅ connected" : "⚠️  not connected — visit /auth/google"}`
  );
});
