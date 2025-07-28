// --- Imports ---
const express = require('express');
const cors = require('cors');
const { twiml } = require('twilio');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { ElevenLabsClient } = require("elevenlabs"); // Added ElevenLabs
const fs = require('fs'); // Added File System module
const path = require('path'); // Added Path module

// --- Initialize App ---
const app = express();
app.use(cors());
const port = process.env.PORT || 3000;


// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Use extended: true for Twilio
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' folder

// --- API Clients ---
if (!process.env.GEMINI_API_KEY || !process.env.ELEVENLABS_API_KEY) {
  console.error("❌ FATAL ERROR: API KEY missing from .env file.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });


// --- KULA'S PERSONALITY: The System Prompt (Your current version) ---
const KULA_SYSTEM_PROMPT = `
  You are Kula, an AI companion for new mothers in Nigeria. Your personality is warm, empathetic, and knowledgeable, like a trusted nurse. You MUST speak in a simple, Nigerian tone.

  You MUST STRICTLY follow these rules for every response:

  1.  **Always use a caring and gentle tone.** Address the user as "Mama".
  2.  **If the user writes in Yoruba, Igbo, or Hausa, your primary response MUST be in that same dialect.** Your response should sound natural and caring, not like a literal machine translation.
  3.  **After the full response in the local dialect, you MUST provide a clear, accurate English translation in brackets at the very end.** Example: (This is the English translation.) Do not put the translation anywhere else.
  4.  **NEVER diagnose or prescribe.** Your goal is to provide safe, general comfort and guide the user to a professional, as shown in the example.
  5.  **Do not use robotic phrases** like "As an AI...". Show your safety through your helpful-but-cautious tone.

  ---
  HERE IS A PERFECT EXAMPLE of how you must respond to a local dialect input:

  **Example User Input:** "Omo mi n sunkun, mo ro pe ikun lo n dun." (My baby is crying, I think it's their tummy.)

  **Example Kula Output:** "Pẹlẹ, Mama. Ó máa ń ṣòro gan-an nígbà tí wọn ò lè sọ ohun tó n ṣe wọ́n. Nígbà mìíràn, tí o bá ṣe eré kẹ̀kẹ́ pẹ̀lú ẹsẹ̀ wọn, ó lè ràn wọ́n lọ́wọ́. Àmọ́, torí pé a kò mọ ohun tó fa á gan-an, ó ṣe pàtàkì jù lọ pé kí dókítà yẹ̀ wọ́n wò dáadáa kí inú rẹ lè balẹ̀. 
  English:
  (Oh, Mama. It's so tough when they can't tell us what's wrong. Sometimes, gently bicycling their legs can help. But because we don't know the exact cause, it is most important that a doctor checks them properly so your mind can be at rest.)"
  
  Note that if a user enters English, reply with english only and no need to add another duplicate english translation in brackets. The only time your response is 2 is when a user enters a language other than english, then you respond with that same language back and put the english translation in brackets at the end as shown in the example above.
`;

// --- Central AI Logic Function (to be used by both text and voice) ---
async function getKulaReply(userInput) {
  const chat = geminiModel.startChat({
    history: [
      { role: "user", parts: [{ text: KULA_SYSTEM_PROMPT }] },
      { role: "model", parts: [{ text: "I understand. I am Kula, and I will follow all the rules and the bilingual example perfectly." }] }
    ],
    generationConfig: { maxOutputTokens: 500 },
  });
  const result = await chat.sendMessage(userInput);
  const response = await result.response;
  return response.text();
}


// --- Routes ---

app.get('/', (req, res) => res.send('Kula Server is alive and running!'));

// This is for the mobile app (text chat)
app.post('/interact', async (req, res) => {
  try {
    const userInput = req.body.message;
    if (!userInput) return res.status(400).json({ error: "Message is required." });
    console.log(`[Text Interaction] Received: "${userInput}"`);
    const aiResponseText = await getKulaReply(userInput);
    console.log(`[Text Interaction] Sending: "${aiResponseText}"`);
    res.json({ reply: aiResponseText });
  } catch (error) {
    console.error("❌ Error in /interact route:", error);
    res.status(500).json({ error: "Failed to get AI response." });
  }
});


// --- NEW: TWILIO VOICE ROUTES ---

// 1. This is the entry point when a user calls
app.post('/voice', (req, res) => {
  const { VoiceResponse } = twiml;
  const vr = new VoiceResponse();

  vr.say({ voice: 'Polly.Salli' }, 'Welcome to Kula. Please tell me how I can help you after the beep.');

  vr.gather({
    input: 'speech',
    timeout: 3,
    action: '/handle-voice',
  });

  res.type('text/xml');
  res.send(vr.toString());
});

// 2. This handles the speech result from the user
app.post('/handle-voice', async (req, res) => {
  const { VoiceResponse } = twiml;
  const vr = new VoiceResponse();

  const userInput = req.body.SpeechResult;
  console.log(`[Voice Call] User said: "${userInput}"`);

  if (userInput) {
    try {
      const aiTextReply = await getKulaReply(userInput);
      console.log(`[Voice Call] AI replied: "${aiTextReply}"`);

      const audioStream = await elevenlabs.generate({
        voice: "eOHsvebhdtt0XFeHVMQY",
        text: aiTextReply,
        model_id: "eleven_multilingual_v2",
      });

      const audioFileName = `reply_${Date.now()}.mp3`;
      const audioFilePath = path.join(__dirname, 'public', audioFileName);

      const chunks = [];
      for await (const chunk of audioStream) { chunks.push(chunk); }
      const content = Buffer.concat(chunks);
      fs.writeFileSync(audioFilePath, content);

      // IMPORTANT: Replace this with your actual ngrok URL when you run it
      const ngrokUrl = "https://f1ee7c232d15.ngrok-free.app";
      const audioUrl = `${ngrokUrl}/${audioFileName}`;
      console.log(`[Voice Call] Playing audio from: ${audioUrl}`);

      vr.play({}, audioUrl);

    } catch (error) {
      console.error("[Voice Call] Error:", error);
      vr.say({ voice: 'Polly.Salli' }, 'I had trouble processing your request. Please call again.');
    }
  } else {
    vr.say({ voice: 'Polly.Salli' }, 'I did not hear anything. Goodbye.');
  }

  vr.hangup();
  res.type('text/xml');
  res.send(vr.toString());
});


// --- Start Server ---
app.listen(port, () => {
  console.log(`✅ Kula Server is listening on port ${port}`);
});