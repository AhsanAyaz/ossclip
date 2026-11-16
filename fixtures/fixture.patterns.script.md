# Pattern-scene fixture script (explainer phase 2, FINDINGS §161)

A second `--script` fixture for `fixtures/fixture.mp4`, beside
`fixture.script.md`: the same approach (its spoken lines are the fixture's own
words from `fixture.transcript.json`, so every cue aligns at a score of 1),
with the 22 words split into six short lines so each can carry a cue. Every
cue is hinted, one per phase-2 component: the four script-only cards, then the
typed `TerminalMock` and the counting `StatCard`. Run it with `--look
explainer`, which is the only look that types and counts. No clip, so there is
nothing to make first.

🎬 [CardRow] three steps
🗣️ Hello everyone,

🎬 [CtaCard] comment a word
🗣️ welcome back.

🎬 [BugCard] the first problem
🗣️ Today I want

🎬 [PhoneDemo] captions on a phone
🗣️ to show you something cool.

🎬 [TerminalMock] the command
🗣️ This raw take becomes

🎬 [StatCard] one number
🗣️ a clean edit automatically.
