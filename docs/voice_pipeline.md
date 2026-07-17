# myFamiPedia — Voice Pipeline

Recording → ElevenLabs Scribe transcription → ElevenLabs cloning → four-moment consent flow.

## 1. Recording → transcript (every session, always)

1. Facilitated interview session (Section 3) or an ad-hoc voice memory records locally on-device, uploads to R2 on completion (`interview_answers.audio_r2_key` or `memories.media_url`).
2. `POST /interview-sessions/:id/complete` enqueues one `Q_TRANS` job per answer.
3. Worker calls ElevenLabs' Speech-to-Text API (`scribe_v2`), writes `transcript` back onto `interview_answers`, then creates the corresponding `memories` row (`provenance_type = 'voice'`, `provenance_label` auto-set e.g. "Recorded by Marie with Hélène, March 2026"). Originally used OpenAI Whisper; switched to ElevenLabs since the project already needs an ElevenLabs key for cloning below, and Scribe v2 benchmarks at or above Whisper v3 on accuracy (particularly non-English) — see section 5. This removed `OPENAI_API_KEY` from the required env vars.
4. Same worker checks `interview_answer_photos` for that answer — any photo captured or uploaded mid-recording (see below) gets copied into `memory_photos` against the newly created `memory_id`.
5. `Q_NOTIF` fires "[Grandmother] just shared 6 new memories" once all answers in the session are transcribed.

**Mid-conversation photo capture:** the session screen keeps a camera/library button live throughout recording, not just before it starts — someone can snap or pick a photo the moment a memory comes up ("that's the dress I wore") without stopping the conversation. Photo uploads attach to `interview_answers.id` immediately (that row exists from the start of the turn); they don't wait for transcription. Practical constraint worth flagging: capture has to happen through an in-app camera view (Expo Camera embedded in the session screen), not a system camera launch — handing off to the OS camera app suspends the calling app on most platforms and would cut the audio recording. A quick in-app shutter with a small "photo added" confirmation keeps the conversation's flow intact, which matters given the whole session design leans on natural, uninterrupted speech.

This path is independent of voice cloning — transcription and real-audio playback work with zero consent overhead, since the recording itself was made with the person present and participating.

## 2. Voice cloning accumulation (Q_VOICE worker)

`voice_models.audio_seconds_accumulated` increments every time a new transcribed answer is attached to that person. Thresholds drive the four-moment flow:

| Trigger | Threshold | Action |
|---|---|---|
| Preview | ~1–2 min accumulated | Worker calls ElevenLabs instant-clone create → generates a 10s preview clip → `voice_models.consent_status = 'previewed'`. No consent asked yet. |
| Decision prompt | ~30 min accumulated | App surfaces full-screen decision moment with a live 30s demo (fresh synthesis call). Blocks further audio use until answered. |
| Consent | user taps "Yes, use my voice" | `POST /persons/:id/voice-model/consent` → `consent_status='consented'`, `consent_date`, `consented_by = person_id` (self only — enforced at DB layer, see privacy doc). Confirmation screen immediately follows (second tap, no new backend state — UI-only reinforcement). |
| Professional upgrade | 30 min – 2–3 hr accumulated | Worker re-trains via ElevenLabs professional clone endpoint as more sessions land; `tier` flips `instant → professional` transparently, no re-consent required (same person, same original consent). |
| "Ask me later" | — | `consent_status` stays `previewed`; worker re-prompts after N additional minutes accumulate. |
| "No, never" | — | `consent_status = 'revoked'`, ElevenLabs model deleted, worker stops accumulating for this person permanently. |

**Copy convention:** all four moments address the subject directly in second person ("bring your voice to life," "here's what you agreed to"), never by name in third person ("bring Jean's voice to life"). `consented_by` is enforced as self-only at the DB layer specifically because this is the subject's own decision about their own voice — the copy should read that way too, regardless of whether a facilitator is physically holding the phone during a session.

## 3. Ongoing control

`voice-model/pause` and `voice-model/revoke` are always available in Settings. Pause is reversible (`consent_status='paused'`, synthesis blocked, model retained). Revoke deletes the ElevenLabs model and is treated as equivalent to "No, never" going forward — original recordings are never affected either way, since real audio lives in `memories`/`interview_answers`, not in `voice_models`.

## 4. Ask-feature resolution order (runtime, not a pipeline job)

`POST /persons/:id/ask`:
1. Embed the question (Voyage AI), search `memories.embedding` (person-scoped) for real voice/text answers above a similarity threshold → if found, return real clip(s) with play icon + date. Done.
2. If no real match: check `voice_models.consent_status == 'consented'` (not paused/revoked). If true, call ElevenLabs TTS with the cloned model over an AI-drafted answer (Claude synthesizes the text from the person's other memories) → return with the mandatory AI badge + non-collapsible disclaimer sentence.
3. If no real match and no active consent (never consented, paused, revoked, or **person died before consenting**): return a plain gap-acknowledgment ("no recording found") — never synthesize. Step 3's death case is enforced structurally: `consent_status` can only reach `'consented'` via the explicit consent endpoint, and that endpoint checks `persons.death_date IS NULL` before allowing the transition.

## 5. Cost/ops notes

ElevenLabs Scribe v2 transcription: billed per `Q_TRANS` job, priced per audio minute — cheap enough to run on every answer unconditionally. ElevenLabs cloning/TTS calls are the more expensive, rate-limited leg — worth queuing with retry/backoff rather than calling inline from the API request path, since a facilitator finishing a session shouldn't block on clone training.

**Why ElevenLabs over OpenAI here (as of mid-2026):** independent benchmarks (FLEURS, Common Voice) put Scribe's word error rate at or below Whisper v3's, with a bigger gap on non-English languages — relevant since myFamiPedia expects multilingual families. OpenAI's Whisper successor, `gpt-4o-transcribe`, narrows that gap (~4.1% WER vs Whisper v3's 5.3%) and its `-diarize` variant adds automatic speaker labeling, which Scribe v2 also supports natively (`diarize: true`, up to 32 speakers) — not turned on here since each interview answer is currently treated as one speaker's transcript, but worth revisiting if facilitator/subject cross-talk within an answer ever needs separating. OpenAI's other angle worth knowing about: real-time streaming transcription (`gpt-realtime-whisper`), which could power live captions during recording rather than only a transcript afterward — Scribe v2 Realtime offers the same idea (sub-150ms latency) if that's wanted without adding OpenAI back in.
