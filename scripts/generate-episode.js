import fs from "fs";
import path from "path";
import { XMLBuilder } from "fast-xml-parser";

// ---- Config (all from env / GitHub Actions secrets & variables) ----
const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
const ELEVENLABS_API_KEY = requireEnv("ELEVENLABS_API_KEY");
const ELEVENLABS_VOICE_ID = requireEnv("ELEVENLABS_VOICE_ID");
const PODCAST_BASE_URL = requireEnv("PODCAST_BASE_URL").replace(/\/+$/, ""); // e.g. https://<user>.github.io/mena-daily-brief
const PODCAST_TITLE = process.env.PODCAST_TITLE || "Daily Digest";
const PODCAST_AUTHOR = process.env.PODCAST_AUTHOR || "Private Feed";
const PODCAST_EMAIL = process.env.PODCAST_EMAIL || "noreply@example.com";
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
// Rolling window: prune episodes older than this many days (keeps repo & hosting small).
const ROLLING_WINDOW_DAYS = Number(process.env.ROLLING_WINDOW_DAYS || 45);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EPISODES_DIR = path.join(ROOT, "episodes");
const FEED_PATH = path.join(ROOT, "feed.xml");
const COVER_PATH = path.join(ROOT, "cover.png");

const FEED_DESCRIPTION =
  "A daily AI-generated audio briefing on the three stories that matter most across the Middle East, the US, and the UK — economy, geopolitics, and AI.";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---- Step 1: ask Claude to research + write a spoken-word briefing script ----
async function generateScript() {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const systemPrompt = `You are the writer and host of a daily audio news briefing, read aloud by a text-to-speech engine to a smart, time-poor listener who wants the few things that genuinely matter today.
Pick the three biggest stories worth caring about across the Middle East, the United States, and the United Kingdom, weighted toward economy, geopolitics, and AI. Choose purely on importance — a story doesn't need to touch all three themes, and the three don't need to be spread across the regions; if the day's top three are all one place or one theme, so be it. Lead with the single most consequential story and work down.
Lean on reputable outlets — BBC, Bloomberg, Reuters, the Financial Times and similar — and favour hard specifics: named people and companies, figures, market moves, policy detail. For each story, land why it matters in a sentence rather than just reporting that it happened. Skip celebrity, sport, and lifestyle news unless it carries real economic or geopolitical weight.
Honesty: report only what you actually found while searching. Never invent figures, quotes, names, or events, and don't imply more certainty than the sources support.
Delivery: natural spoken sentences only — no markdown, no bullet points, no headers, no URLs, no citations, no emojis, no stage directions. Sharp, direct, conversational — a well-sourced colleague giving you the real rundown, not a formal news anchor and not breathless hype. Open with a one-line hook, cover the three stories, then close with a quick sign-off. Keep it tight — roughly 300 to 450 words, about two to three minutes.`;

  const userPrompt = `Today is ${today}. Search the web for today's most important news across the Middle East, the United States, and the United Kingdom, with an eye on economy, geopolitics, and AI. Identify the three stories from the last 24 hours that a smart reader should genuinely care about — chosen on importance alone, not to tick every region or theme — leaning on reputable sources such as BBC, Bloomberg, Reuters, and the Financial Times. Then write the finished spoken briefing, leading with the biggest story.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      // Web search shares this budget, so keep generous headroom above the
      // ~450-word script or the final sentence gets truncated mid-thought.
      max_tokens: 5000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      // Note: allowed_domains can't include BBC/Reuters/AP/FT — those publishers
      // block Anthropic's web-search crawler (returns 400). So sourcing stays
      // open; the prompt still steers toward reputable outlets it can reach.
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const script = data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!script) throw new Error("Claude returned no script text.");
  // If we still hit the token ceiling the script is cut off mid-sentence; fail
  // loudly rather than narrating a truncated episode.
  if (data.stop_reason === "max_tokens") {
    throw new Error(
      "Claude hit max_tokens — script was truncated. Raise max_tokens and retry."
    );
  }
  return script;
}

// ---- Step 2: send script to ElevenLabs for narration ----
async function synthesizeAudio(script) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": ELEVENLABS_API_KEY,
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: script,
        model_id: ELEVENLABS_MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.8 },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`ElevenLabs API error: ${res.status} ${await res.text()}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ---- Step 3: save episode + metadata sidecar ----
function saveEpisode(dateStamp, script, audioBuffer) {
  fs.mkdirSync(EPISODES_DIR, { recursive: true });
  fs.writeFileSync(path.join(EPISODES_DIR, `${dateStamp}.mp3`), audioBuffer);

  const wordCount = script.trim().split(/\s+/).length;
  const estimatedSeconds = Math.max(1, Math.round((wordCount / 150) * 60)); // ~150 wpm speaking pace

  // A short summary for the feed, trimmed on a word boundary.
  const firstLine = script.replace(/\s+/g, " ").trim();
  const summary =
    firstLine.length > 280 ? firstLine.slice(0, 280).replace(/\s+\S*$/, "") + "…" : firstLine;

  const meta = {
    date: dateStamp,
    title: `Daily Digest — ${dateStamp}`,
    summary,
    wordCount,
    fileSizeBytes: audioBuffer.length,
    durationSeconds: estimatedSeconds,
  };
  fs.writeFileSync(
    path.join(EPISODES_DIR, `${dateStamp}.json`),
    JSON.stringify(meta, null, 2)
  );

  return meta;
}

// ---- Step 4: prune episodes older than the rolling window ----
function pruneOldEpisodes() {
  if (!fs.existsSync(EPISODES_DIR)) return;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - ROLLING_WINDOW_DAYS);

  const dates = fs
    .readdirSync(EPISODES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));

  for (const d of dates) {
    if (new Date(`${d}T00:00:00Z`) < cutoff) {
      for (const ext of [".mp3", ".json"]) {
        const p = path.join(EPISODES_DIR, `${d}${ext}`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      console.log(`Pruned old episode ${d}`);
    }
  }
}

// ---- Step 5: rebuild the RSS 2.0 feed from whatever episodes exist on disk ----
function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function buildFeed() {
  const files = fs.existsSync(EPISODES_DIR)
    ? fs.readdirSync(EPISODES_DIR).filter((f) => f.endsWith(".json"))
    : [];
  const episodes = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(EPISODES_DIR, f), "utf-8")))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  const hasCover = fs.existsSync(COVER_PATH);
  const coverUrl = `${PODCAST_BASE_URL}/cover.png`;

  const items = episodes.map((ep) => {
    const mp3Url = `${PODCAST_BASE_URL}/episodes/${ep.date}.mp3`;
    return {
      title: ep.title,
      description: ep.summary,
      "itunes:title": ep.title,
      "itunes:summary": ep.summary,
      guid: { "#text": mp3Url, "@_isPermaLink": "true" },
      pubDate: new Date(`${ep.date}T06:00:00Z`).toUTCString(),
      enclosure: {
        "@_url": mp3Url,
        "@_length": String(ep.fileSizeBytes),
        "@_type": "audio/mpeg",
      },
      "itunes:duration": formatDuration(ep.durationSeconds),
      "itunes:episodeType": "full",
      "itunes:explicit": "false",
    };
  });

  const channel = {
    title: PODCAST_TITLE,
    link: PODCAST_BASE_URL,
    "atom:link": {
      "@_href": `${PODCAST_BASE_URL}/feed.xml`,
      "@_rel": "self",
      "@_type": "application/rss+xml",
    },
    language: "en-us",
    description: FEED_DESCRIPTION,
    lastBuildDate: new Date().toUTCString(),
    ...(episodes[0]
      ? { pubDate: new Date(`${episodes[0].date}T06:00:00Z`).toUTCString() }
      : {}),
    "itunes:author": PODCAST_AUTHOR,
    "itunes:summary": FEED_DESCRIPTION,
    "itunes:type": "episodic",
    "itunes:explicit": "false",
    "itunes:owner": {
      "itunes:name": PODCAST_AUTHOR,
      "itunes:email": PODCAST_EMAIL,
    },
    "itunes:category": { "@_text": "News", "itunes:category": { "@_text": "Tech News" } },
    ...(hasCover ? { "itunes:image": { "@_href": coverUrl } } : {}),
    ...(hasCover
      ? { image: { url: coverUrl, title: PODCAST_TITLE, link: PODCAST_BASE_URL } }
      : {}),
    item: items,
  };

  const feedObj = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    rss: {
      "@_version": "2.0",
      "@_xmlns:itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
      "@_xmlns:atom": "http://www.w3.org/2005/Atom",
      channel,
    },
  };

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true,
    suppressBooleanAttributes: false, // keep isPermaLink="true" intact
  });
  fs.writeFileSync(FEED_PATH, builder.build(feedObj));
}

export { buildFeed, saveEpisode, pruneOldEpisodes };

// ---- Run ----
async function main() {
  const dateStamp = todayStamp();
  console.log(`Generating briefing for ${dateStamp}...`);

  const script = await generateScript();
  console.log(`Script ready (${script.trim().split(/\s+/).length} words). Sending to ElevenLabs...`);

  const audio = await synthesizeAudio(script);
  console.log(`Audio ready (${audio.length} bytes). Saving...`);

  saveEpisode(dateStamp, script, audio);
  pruneOldEpisodes();
  buildFeed();

  console.log("Done. Episode + feed.xml updated.");
}

// Only run the full pipeline when invoked directly (not when imported for tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
