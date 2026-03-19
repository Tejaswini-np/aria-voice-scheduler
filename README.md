# 🎙️ ARIA — Voice Scheduling Agent

> **A**utomated **R**eal-time **I**ntelligence **A**ssistant  
> _Speak to schedule. ARIA books it on your Google Calendar._

---

## ✨ What It Does

ARIA is a fully voice-driven scheduling agent. You speak to it in real-time — it asks for your name, preferred date and time, and a meeting title — then creates a confirmed Google Calendar event, all without touching a keyboard.

**Conversation flow:**
1. 👋 ARIA greets you and introduces herself
2. 📝 Asks for your **name**
3. 📅 Asks for your preferred **date** (understands "tomorrow", "next Monday", etc.)
4. 🕐 Asks for your preferred **time** ("2pm", "3:30 in the afternoon")
5. 💬 Optionally asks for a **meeting title**
6. ✅ **Confirms** all details aloud before creating
7. 📆 **Creates the Google Calendar event** and tells you it's done

---

## 🔗 Deployed URL

> **https://aria-voice-scheduler.onrender.com**

### How to Test

1. Open the URL above in **Chrome or Edge** (best WebAudio support)
2. Click the **glowing blue orb** (or "Start Session")
3. Allow microphone access when prompted
4. **Speak naturally** — ARIA will guide you through scheduling

> 💡 **Tip:** Use a headset or earbuds to prevent mic feedback during ARIA's responses.

---

## 🏗️ Architecture

```
Browser (WebRTC Mic)
        │  PCM16 audio stream (WebSocket)
        ▼
┌─────────────────────────────────────┐
│         Node.js / Express Server    │
│                                     │
│   WebSocket Proxy (ws library)      │
│   ┌─────────────────────────────┐   │
│   │  OpenAI Realtime API Proxy  │   │
│   │  - Injects system prompt    │   │
│   │  - Registers tools          │   │
│   │  - Intercepts function calls│   │
│   └─────────────────────────────┘   │
│                                     │
│   Function Call Handler             │
│   → create_calendar_event()         │
│         │                           │
│         ▼                           │
│   Google Calendar API (v3)          │
│   (via googleapis + OAuth2)         │
└─────────────────────────────────────┘
        │  PCM16 audio (TTS) + transcripts
        ▼
Browser (AudioContext playback + UI)
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| **Voice / LLM** | OpenAI Realtime API (`gpt-4o-realtime-preview`) |
| **Audio capture** | WebAudio API + ScriptProcessorNode → PCM16 |
| **Audio playback** | AudioContext buffer scheduling |
| **Backend** | Node.js + Express + `ws` (WebSocket) |
| **Calendar** | Google Calendar API v3 via `googleapis` |
| **Auth** | Google OAuth2 (offline, refresh token) |
| **Deployment** | Render.com (free tier) |

---

## 📅 Calendar Integration Explained

### How It Works

The server uses the **Google Calendar API v3** through Google's official `googleapis` Node.js client. Authentication is handled via **OAuth2 with an offline refresh token** — so the server can create calendar events server-side without requiring the user to log in each time.

**Event creation details:**
- Duration: **1 hour** (adjustable in `server/index.js`)
- Timezone: **America/Chicago** (Dallas/Plano CT — configurable)
- Reminders: **15-minute popup + 60-minute email**
- Calendar: **primary** (the authenticated user's main calendar)

### How the AI Calls the Calendar

The OpenAI Realtime model is given a **function/tool definition**:

```json
{
  "name": "create_calendar_event",
  "parameters": {
    "name": "string — booker's full name",
    "date": "string — YYYY-MM-DD",
    "time": "string — HH:MM (24hr)",
    "title": "string — optional meeting title"
  }
}
```

When ARIA collects and confirms all details, the model **calls this function**. The server intercepts the call, executes `calendar.events.insert(...)`, and returns the created event back to the model — which then tells the user it's done.

### OAuth2 Setup (one-time)

1. Create a Google Cloud project → Enable Calendar API
2. Create OAuth2 credentials (Web application type)
3. Add `http://localhost:3000/auth/callback` as authorized redirect URI
4. Run the server and visit `http://localhost:3000/auth/google`
5. Authorize → copy the `GOOGLE_REFRESH_TOKEN` to `.env`

From that point on, the refresh token is reused automatically.

---

## 🚀 Run Locally

### Prerequisites

- Node.js ≥ 18
- An [OpenAI API key](https://platform.openai.com/api-keys) with Realtime API access
- A [Google Cloud project](https://console.cloud.google.com) with Calendar API enabled

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/tejaswini-popuri/aria-voice-scheduler.git
cd aria-voice-scheduler

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — fill in OPENAI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

# 4. Authorize Google Calendar (one-time)
node server/index.js
# Visit http://localhost:3000/auth/google
# Authorize → copy refresh token into .env as GOOGLE_REFRESH_TOKEN

# 5. Start the server
npm start
# or for auto-reload during development:
npm run dev

# 6. Open http://localhost:3000
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | ✅ | OpenAI API key with Realtime access |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth2 client secret |
| `GOOGLE_REDIRECT_URI` | ✅ | OAuth callback URL |
| `GOOGLE_REFRESH_TOKEN` | ✅ | Set after first auth flow |
| `PORT` | Optional | Default: 3000 |

---

## ☁️ Deploy to Render

1. Fork this repo to your GitHub
2. Go to [render.com](https://render.com) → New Web Service → connect your repo
3. Build command: `npm install`
4. Start command: `node server/index.js`
5. Add all environment variables in the Render dashboard
6. Update `GOOGLE_REDIRECT_URI` to `https://your-app.onrender.com/auth/callback`
7. Visit `https://your-app.onrender.com/auth/google` to authorize Google Calendar
8. Copy the refresh token into Render's env vars → redeploy

---

## 📸 Screenshots

### Main Interface
![ARIA Voice Agent UI showing the glowing blue orb, status indicator, and conversation transcript area]

### Active Conversation
```
ARIA:  Hi! I'm ARIA, your scheduling assistant. May I have your name?
YOU:   Tejaswini
ARIA:  Nice to meet you, Tejaswini! What date works best for your meeting?
YOU:   This coming Friday
ARIA:  Friday, March 21st — got it! And what time works for you?
YOU:   3pm
ARIA:  Perfect, 3:00 PM. What would you like to call this meeting?
YOU:   Product sync
ARIA:  So I'll schedule "Product sync" on Friday, March 21st at 3:00 PM Central Time. Does that sound right?
YOU:   Yes
ARIA:  Your event is on the calendar! "Product sync" is set for March 21st at 3 PM. Have a great meeting!
```

### Event Created Confirmation Card
![Green confirmation card showing event title, date, time, and "View in Google Calendar" link]

### Google Calendar Event
![Google Calendar showing the created "Product sync" event on March 21st at 3:00 PM]

---

## 📁 Project Structure

```
aria-voice-scheduler/
├── server/
│   └── index.js          # Express + WebSocket proxy + Calendar integration
├── public/
│   └── index.html        # Frontend UI (single-file, no build step)
├── .env.example          # Environment variable template
├── .gitignore
├── package.json
├── render.yaml           # One-click Render deployment config
└── README.md
```

---

## 🔑 Key Design Decisions

**Why OpenAI Realtime API?**  
It provides end-to-end audio streaming (speech-in, speech-out) with native function calling. This eliminates the need to chain separate STT → LLM → TTS services, reducing latency to near real-time.

**Why a server-side WebSocket proxy?**  
The OpenAI Realtime API key cannot be safely exposed to the browser. The server acts as a proxy that injects the system prompt, tool definitions, and API key server-side — while transparently relaying audio in both directions.

**Why Google Calendar API with a refresh token?**  
Unlike webhook-based integrations, the refresh token pattern allows the server to create events on behalf of the authorized user with zero user friction after the one-time OAuth setup.

---

## 👤 Author

**Naga Tejaswini Popuri**  
Data Scientist & AI/Automation Engineer  
[LinkedIn](https://linkedin.com/in/tejaswini-popuri) · [GitHub](https://github.com/tejaswini-popuri)

---

## 📄 License

MIT — use freely, credit appreciated.
