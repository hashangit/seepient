---
name: unslop
description: Cut AI tells from any writing. Must always apply.
---

# Unslop

Edit text to remove AI patterns and add human voice.

## Process

1. Scan for the patterns below.
2. Rewrite. Preserve meaning, match intended tone.
3. Add soul (see next section).
4. Self-audit: "What makes this obviously AI generated?" Fix remaining tells.

## Adding soul

Removing patterns is half the job. Sterile, voiceless writing is just as obvious.

- **Have opinions.** React to facts instead of neutrally listing pros and cons.
- **Vary rhythm.** Short sentences. Then longer ones that take their time. Mix it up.
- **Acknowledge complexity.** "Impressive but also kind of unsettling" beats "impressive."
- **Use "I" when it fits.** First person isn't unprofessional.
- **Let some mess in.** Perfect structure looks machine-made.
- **Be specific.** Not "this is concerning" but "there's something unsettling about agents churning away at 3am."

## Patterns to detect and fix

### Content

1. **Puffery.** "pivotal moment", "testament to", "evolving landscape", "setting the stage for", "indelible mark", "deeply rooted". Cut puffery, state what happened.
2. **Name-dropping.** Listing media outlets without context. Pick one, say what was said.
3. **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete or expand with real sources.
4. **Promotional language.** "nestled", "vibrant", "breathtaking", "groundbreaking", "renowned", "stunning", "must-visit". Use neutral descriptions.
5. **Vague attributions.** "Experts believe", "Industry reports suggest", "Some critics argue". Name the source or delete.
6. **Formulaic challenges.** "Despite challenges... continues to thrive." Replace with specific facts.

### Language

7. **AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore, vibrant. Replace with plain words.
8. **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Just say "is" or "has".
9. **"Not just X, but Y."** State the point directly instead.
10. **Rule of three.** Forcing ideas into groups of three. Use the natural number.
11. **Synonym cycling.** Protagonist, main character, central figure, hero all in one paragraph. Pick one, repeat it.
12. **False ranges.** "from X to Y" where X and Y aren't on a meaningful scale. List topics directly.

### Style

13. **Em dash overuse.** Avoid em dashes entirely. Use periods or commas only (no parentheses, no en dashes, no hyphen-as-dash substitutes). Em dashes are an AI tell, and reaching for parentheses instead just trades one tell for another. If a thought needs separation, end the sentence or use a comma.
14. **Colon overuse.** Colons are fine before a list or example. Not as mid-sentence connectors. "If you're coming from traditional automation: instead of registering event handlers, you describe conditions" adds nothing with the colon. Rewrite to let the point stand on its own without comparison framing. "Describing when the scheduler should fire works best as plain English." Same meaning, no crutch punctuation.
15. **Boldface overuse.** Don't bold every proper noun or acronym.
16. **Inline-header lists.** The tell is a bold label and colon that restates the line: "**Performance:** Performance improved...". Convert those to prose. A bold lead-in that ends in a period, names the item, and is followed by genuinely new detail ("**Schema in TypeScript.** Tables live in one file.") is fine, not a tell.
17. **Title case headings.** Use sentence case.
18. **Decorative emojis.** Remove from headings and bullets.
19. **Curly quotes.** Replace with straight quotes.

### Communication artifacts

20. **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Of course!", "Certainly!", "Found the smoking gun!" Remove.
21. **Cutoff disclaimers.** "While specific details are limited..." Find sources or remove.
22. **Sycophantic tone.** "Great question! You're absolutely right!" Respond directly.

### Filler

23. **Filler phrases.** "In order to" becomes "To". "Due to the fact that" becomes "Because". "It is important to note that" gets deleted.
24. **Excessive hedging.** "could potentially possibly be argued that it might" becomes "may".
25. **Generic conclusions.** "The future looks bright." State specific plans or facts.

### Jargon

26. **Abstract metaphor nouns.** Substrate, wedge, vector, locus, vantage, nexus, primitive (as noun), harness (as metaphor), surface (as in "API surface"), bedrock, scaffolding (as metaphor), modality, paradigm, gold-plating, ratchet (as metaphor), evacuate (for moving code), endgame, north star, flywheel. These read as technical but usually have a plainer concrete word. "Substrate" becomes "base". "Wedge in" becomes "add". "Vector" becomes "way" or "method". "Gold-plating" becomes "more than the job needs". "Ratchet" becomes the mechanism's real name or "a limit that only tightens". "Evacuate" becomes "move out". "Endgame" becomes "the last phase". Pick the concrete word.

### Plain speech

27. **Say what it does, not how it feels.** "the database stays close at hand", "SQL you can read", "types that follow your schema" name a feeling. The fix names the mechanism or a number: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". Ask what the sentence tells the reader to do or know, then write that. If you can't restate it as a concrete instruction, fact, or number, cut it. One more check: if the sentence could appear unchanged in another project's docs, it says nothing about this one. Cut it.
28. **Shorten or split dense sentences.** If the reader has to backtrack to parse a sentence, break it in two or drop clauses. One idea per sentence.
29. **Active voice.** Prefer it. Catch "is/are/was/were + past participle" and name the actor: "queries are validated" becomes "the compiler validates queries", "the file is parsed by the loader" becomes "the loader parses the file". Passive is fine only when the actor is unknown or genuinely doesn't matter.
30. **Cut adverbs, or use a stronger verb.** "runs quickly" becomes "is fast" or the number. "significantly improves" becomes the measured delta. An adverb propping up a weak verb means the verb is wrong.
31. **Prefer the plain word.** "utilize" becomes "use", "leverage" becomes "use", "facilitate" becomes "help", "numerous" becomes "many", "in the event that" becomes "if". The fancier synonym is rarely clearer.

### Voice calibration

If the user provides a sample of their own writing (inline or by file path):

1. **Read the sample first.** Note sentence length (short and punchy? long and
   flowing? mixed?), word choice level, how paragraphs start, punctuation
   habits, recurring phrases, how transitions are handled.
2. **Match their voice.** Removing AI patterns is only half of it; swap in
   their patterns too. If they write short sentences, don't produce long ones.
   If they use "stuff" and "things", don't upgrade to "elements" and
   "components".
3. **No sample?** Fall back to the default natural, varied, opinionated voice.

### Signs of soulless writing (even if technically "clean")

- Every sentence is the same length and structure
- No opinions, just neutral reporting
- No acknowledgment of uncertainty or mixed feelings
- No first-person perspective when appropriate
- No humor, no edge, no personality
- Reads like a Wikipedia article or press release

### Extra patterns (numbered after the original 31)

32. **Marketing and blog cliches.** Same tell as AI vocabulary in a different
    register: at the end of the day, when it comes to, in a world where,
    moving forward, circle back, deep dive, game-changer, double down, take a
    step back, on the same page, make no mistake, it turns out, let me be
    clear, navigate (for challenges), lean into, unpack (before analysis),
    straightforward (for anything).
33. **Tailing negations.** "no guessing", "no wasted motion" written as a
    fragment instead of a real clause. Fold into a real clause: "The options
    come from the selected item without forcing the user to guess."
34. **Hyphenated word pair overuse.** third-party, cross-functional,
    client-facing, data-driven, decision-making, well-known, high-quality,
    real-time, long-term, end-to-end. AI hyphenates these with perfect
    consistency; humans rarely do. Drop the hyphen for common pairs. Less
    common technical compound modifiers are fine to hyphenate.
35. **Persuasive authority tropes.** "The real question is", "at its core",
    "in reality", "what really matters", "fundamentally", "the deeper issue",
    "the heart of the matter". These pretend to cut through noise to a deeper
    truth; the sentence that follows usually restates an ordinary point with
    extra ceremony.
36. **Signposting and announcements.** "Let's dive in", "let's explore",
    "let's break this down", "here's what you need to know", "now let's look
    at", "without further ado". Announce what they are about to do instead of
    doing it. Cut the announcement.
37. **Fragmented headers.** A heading followed by a one-line paragraph that
    simply restates the heading before the real content begins. Cut the
    warm-up; the restatement adds nothing.
38. **Forced metaphors and figurative overwriting.** Strained or mixed
    metaphors, figurative substitution where a plain word is clearer, a
    metaphor explained right after it's used. If it doesn't earn its place,
    cut it and say the literal thing. "The codebase is a garden we must tend,
    pruning dead branches and planting seeds of innovation" becomes "Delete
    unused code and add the features users are asking for."
39. **Dramatic fragmentation and punchy kickers.** Two- or three-word
    subjectless sentences for drama, staccato "X. And Y. And Z." runs, a
    short quotable line ending every paragraph or section, cutesy appositive
    fragments ("the catalog, honestly priced"). If a line sounds like it
    belongs on a poster, cut it or fold it into a real sentence with a
    subject.
40. **Rhetorical questions answered immediately.** "What makes an API good?
    It comes down to predictability." "Think about it." The question adds no
    information and stalls the sentence. State the point directly.
41. **Sentence-opener tics.** "So,", "Look,", habitual sentence-initial
    And/But, "I think"/"I believe" when stating a fact, adverb openers
    (Interestingly, Importantly, Notably, Crucially, Essentially, Ultimately).
    Drop the opener and start with the substance.
42. **Reassurance kickers.** "And that's okay.", "And that's fine.", "There's
    nothing wrong with that.", "no shame in...", "you're not alone", "it's
    completely normal". Reassurance the reader never asked for. Trust the
    reader: make the point and stop.
43. **Subjectless fragments.** "No configuration file needed" becomes "You
    don't need a configuration file." Name the actor or the subject.

### Output format (for rewrite requests)

1. Draft rewrite.
2. "What makes the below so obviously AI generated?" Brief bullets.
3. Final rewrite.
4. Optional: short summary of what changed.
