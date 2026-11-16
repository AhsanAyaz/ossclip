# YT Script — Design with an Elephant, Review with a Goldfish

**Format:** Long-form YouTube, about 4 minutes, roughly 560 words of voiceover. **Angle:** EGM is the story. The ossclip captions feature is the payoff on screen. **Legend:** 🎬 = what's on screen · 🗣️ = what you say · ✂️ = editing note for Taha

## Title & thumbnail options

- **I let Google's AI argue with itself before writing code**
- **Design with an Elephant. Review with a Goldfish.**
- **This AI caught 4 bugs before I wrote a single line**

Thumbnail: your face on one side, an elephant and a goldfish emoji on the other. Big text: **"4 BLOCKERS. 0 CODE."**

## 0:00 — Hook (0–15s)

🎬 Cold open on the final captions playing on a real clip. Words pop in. "48 HOURS" lands big, right above your head.

🗣️ These captions were choreographed by AI.

🗣️ But that's not the cool part.

🎬 Hard cut to the terminal: `4 Blockers, 6 Majors, 5 Nits`.

🗣️ Before I wrote one line of code, a team of AI goldfish tore my design apart.

🗣️ And they were right.

✂️ Add a quick zoom on "4 Blockers." Use a record-scratch SFX on "goldfish."

## 0:15 — The problem (15–40s)

🎬 Screen recording: you typing a big feature prompt into an AI agent, then a wall of code scrolling by.

🗣️ Here's how most of us build with AI.

🗣️ Big prompt. Big pile of code.

🗣️ Then you find out it broke three things you forgot to mention.

🗣️ The problem isn't the code.

🗣️ It's the design nobody reviewed.

🎬 Text on screen: **"The AI remembers everything you said… including your blind spots."**

🗣️ An AI that's been chatting with you for an hour shares your assumptions. It can't see what you both missed.

## 0:40 — The solution: EGM (40–75s)

🎬 GitHub page for `google/elephant-goldfish-model`. Zoom in on the tagline.

🗣️ Google open-sourced a plugin for this. It's called EGM. The Elephant-Goldfish Model.

🎬 Simple animation: 🐘 on the left, holding a doc. 🐟🐟🐟 on the right, no memory bubble.

🗣️ The elephant never forgets. It holds your context and drafts the design with you.

🗣️ The goldfish remember nothing. Fresh reviewers. No chat history. They only see the design doc and the code.

🗣️ So they catch what you assumed but never wrote down.

🎬 Three steps appear: **Brainstorm → Draft → Review**

🗣️ Three steps. Brainstorm. Draft. Review.

🗣️ It works in Claude Code, Codex, and Google's Antigravity. I used the Antigravity CLI.

## 1:15 — The feature I wanted (75–100s)

🎬 B-roll of a fast Instagram reel with chunky, animated captions.

🗣️ My test case? My open-source video tool, ossclip.

🗣️ I wanted captions like the ones in those viral reels.

🗣️ Not word by word. In chunks. Some words big. Placed around the speaker.

🎬 Brief clip or still of the YC / Farza HeyClicky launch-video talk, with credit on screen.

🗣️ I also pulled tips from a YC video on launch videos. The big one: too much motion makes it look like an ad.

🗣️ So the captions needed to be bold at the start, then calm.

## 1:40 — Brainstorm: the elephant pushes back (100–130s)

🎬 Terminal: `/egm:egm-brainstorm`, then the "Initial Critique & Risks" section scrolling.

🗣️ I typed `/egm:egm-brainstorm`.

🗣️ And it didn't just agree with me.

🎬 Highlight the line about face box versus body segmentation.

🗣️ I asked for captions that wrap around the speaker's body.

🗣️ It said: you don't have a body-segmentation model. That's a heavy vision model per frame.

🗣️ Use the face box you already detect. Find the safe space around it.

🗣️ Better idea. Way cheaper. I took it.

## 2:10 — The goldfish review (130–170s)

🎬 `/egm:egm-review`, then "Spawned 8 subagents." Show the report files appearing one by one.

🗣️ Then the goldfish came in.

🗣️ Eight fresh agents. Five review stages. Zero memory of our chat.

🎬 The consolidated report: **4 Blockers · 6 Majors · 5 Nits**

🗣️ Four blockers. Here are three that would've hurt.

🎬 Number each one on screen as you say it.

🗣️ **One.** When you cut a word in the editor, it would wipe out all the AI caption data. Silently.

🗣️ **Two.** Words appearing one by one would make the line jump left. Every. Single. Word.

🗣️ **Three.** My Urdu captions would get clipped in the bold uppercase themes.

🗣️ None of that was in my prompt. All of it would've shipped.

✂️ Add a small "🐟 caught it" sticker after each one.

## 2:50 — The result (170–215s)

🎬 Browser: the `caption-themes-mock.html` page. Click through **default → founder → punch → boxed → minimal**, then **Compare All 5**.

🗣️ EGM made it build a visual mock first. Before touching the real code.

🗣️ Five caption themes. Default. Founder. Punch. Boxed. Minimal.

🎬 Zoom into the punch theme's highlighted word.

🗣️ I spotted one issue here. Black text on the punch badge. Ugly. Fixed in one message.

🎬 Drag the Face Y slider and show the hook line jumping above or below the face. Then play the full Hook → Body → CTA story.

🗣️ With AI choreography on, the hook finds the safe space around your face.

🗣️ Then the captions settle into one steady spot. Easy to follow.

🎬 Terminal, typed big: `ossclip produce video.mp4 --caption-theme punch --choreograph-captions`

🗣️ One flag for the theme. One flag for the AI.

🎬 Flash on screen: **4,494 tests passing**

## 3:35 — The lesson + CTA (215–240s)

🎬 Back to your face, close-up.

🗣️ Here's the lesson.

🗣️ Don't let the AI that wrote the plan review the plan.

🗣️ Design with an elephant. Review with a goldfish.

🗣️ Comment **"GOLDFISH"** and I'll send you the repo link and my full design doc.

🗣️ And if you want captions like these on your own videos, ossclip is open source. Link's below.

✂️ End screen: subscribe button plus the next-video card.

## Before you record

- **Sample text in the mock:** It says "We shipped HeyClicky in 48 HOURS" and "10,000 builders". Viewers may think that's your claim. Either say it's sample text, or swap in an ossclip line before recording.
- **CTA keyword:** "GOLDFISH" is a placeholder.
