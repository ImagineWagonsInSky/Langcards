# LangCards · Español → Italiano

A phone app for learning **Italian from Spanish** (or the other way round). It installs to your home screen like a normal app, works offline, and has no ads or accounts.

**What's inside**

- **17,787 sentence pairs** (16,491 Spanish and 16,684 Italian sentences), all real human translations from [Tatoeba](https://tatoeba.org), sorted into 5 difficulty levels.
- **3,491 words** with Italian articles (il / lo / la / l’), example sentences and notes. 388 of them are a hand-checked core vocabulary: greetings, numbers, days, verbs…
- Both directions, so roughly 21,000 cards per direction.

## Features

| | |
|---|---|
| 🚀 **Skip ahead** | A placement test (6 questions per level) puts you at the right level. You can also pick the starting level (1–5) on the Home screen, or tap "I already know this" on any new card. |
| 🧠 **Spaced repetition** | Every card is scheduled with an Anki-style SM-2 algorithm, so you review just before you would forget. |
| 🎤 **Speaking** | Like Duolingo: tap the microphone, say the sentence, and get a match score with each word marked green or red. It uses your phone's built-in speech recognition. |
| 🎧 **Listening** | Italian text-to-speech with a 🐢 slow button. Dictation exercises: "type / tap what you hear". |
| 🧩 **Exercise mix** | Multiple choice, word tiles, typing (with an à è é ì ò ù accent bar), listening, speaking and flashcards. |
| ✅ **Fair answer checking** | Accepts any listed translation. Subject pronouns are optional ("Io sono" = "Sono"). Missing accents and one-letter slips are flagged gently. There is an "I was right" button for valid answers the app does not know. |
| ⚠️ **False friends** | 46 Spanish–Italian traps (burro, salir/salire, largo, embarazada, …) with a quiz. |
| 📘 **Grammar tips** | The 13 biggest differences for Spanish speakers, with audio examples. |
| 📖 **Dictionary** | Search 20,000+ entries in either language. Star cards to practise them later. |
| 🔥 **Motivation** | Daily goal ring, streak, weekly chart and progress per level. |
| 📴 **Offline** | Everything is cached on the phone after the first visit. |
| 💾 **Backup** | Progress stays on your phone. Export or import it as a file from Settings. |

## Put it on your phone

The app is a static website (a PWA), so it needs to be served over HTTPS once. The easiest way is **GitHub Pages**:

1. On GitHub open **Settings → Pages**.
2. Under *Build and deployment* pick **Deploy from a branch**, choose the branch with this code and the **/ (root)** folder, then **Save**.
3. After a minute the app is live at `https://<your-username>.github.io/Langcards/`.
4. Open that link on your phone:
   - **iPhone (Safari):** tap Share → **Add to Home Screen**.
   - **Android (Chrome):** tap ⋮ → **Install app** (or *Add to Home screen*).

> GitHub Pages for a **private** repository needs a paid GitHub plan. On a free plan, either make the repository public (it contains only code and openly licensed data) or drag the folder onto any static host, such as Netlify Drop or Cloudflare Pages.

### Microphone and voices

- **Android:** use Chrome. The first time, allow the microphone. Speech recognition needs an internet connection.
- **iPhone:** works in Safari (iOS 14.5+). Turn on *Settings → General → Keyboard → Enable Dictation*. If the microphone button does not work in the home-screen app, use the **Typing** exercise and tap the microphone key on your keyboard instead.
- **No Italian voice?** Android: *Settings → Text-to-speech* → install Italian. iPhone: *Settings → Accessibility → Spoken Content → Voices → Italiano*. Then pick the voice in the app's Settings.
- On a bus? In a lesson, tap **"Can't speak now"** to skip speaking exercises for an hour.

## How the data was made (and checked)

`scripts/build_data.py` rebuilds everything from the original sources. It was designed to avoid wrong cards:

- **Sentences:** only *direct* Spanish↔Italian translations made by people. Translations through a third language (Spanish→English→Italian) were tested and rejected, because they mix up tú/usted/vosotros and genders. Sentences are also dropped when Tatoeba reviewers flagged them, when the author is a self-declared beginner in that language, or when they contain a word that does not exist (a typo).
- **Words:** a word pair is kept only when **two independent sources agree**. The Spanish and Italian WordNets must give it the same meaning, *and* the two words must be among each other's top-3 most frequent translations in the aligned sentences. Inflected forms, gender mismatches (hija → figlio) and verb/noun mix-ups are filtered out. Random samples were reviewed by hand.
- **Articles** (il/lo/la/l’, el/la) are shown only when the corpus is unambiguous: at least 3 occurrences with 85% agreement.
- **Core words, false friends and grammar tips** are hand-written. The core list is automatically cross-checked against the sentence data.

Tatoeba is written by volunteers, so a rare sentence may still be imperfect. Each sentence card has a **Source** link to Tatoeba and a **Hide card** button.

### Sources and licences

| Data | Licence |
|---|---|
| Sentences © [Tatoeba](https://tatoeba.org) contributors | CC BY 2.0 FR |
| Spanish WordNet, [Multilingual Central Repository 3.0](http://adimen.si.ehu.es/web/MCR/) | CC BY 3.0 |
| Italian [MultiWordNet](http://multiwordnet.fbk.eu) | CC BY 3.0 |
| [ItalWordNet](http://datahub.io/dataset/iwn) | ODC-BY 1.0 |
| Difficulty levels from [wordfreq](https://github.com/rspeer/wordfreq) frequencies | (used for scoring only) |

## Development

No build step and no dependencies. It is plain HTML, CSS and JavaScript modules.

```bash
python3 -m http.server 8000          # then open http://localhost:8000
npm test                              # unit tests (answer checking, scheduling)
npm run test:e2e                      # full browser test (needs Playwright + Chromium)
```

Rebuilding the data (only needed to change it):

```bash
pip install -r scripts/requirements.txt
python3 scripts/build_data.py --download   # fetches Tatoeba + Open Multilingual Wordnet into ./raw
python3 scripts/stamp_version.py           # after ANY change to cached files, so phones get the update
```

| Path | What |
|---|---|
| `index.html`, `manifest.webmanifest`, `sw.js` | App shell, install info, offline cache |
| `assets/js/` | `session.js` lessons & exercises · `views.js` screens · `text.js` answer checking · `srs.js` scheduling · `speech.js` voice & microphone · `data.js` cards & search |
| `data/` | Generated `sentences.json`, `words.json`, `meta.json` |
| `scripts/` | Data build, curated core words, icons, cache version stamp |
| `tests/` | Unit tests (`node --test`) and the Playwright end-to-end test |
