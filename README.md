# HSK Trainer (offline)

Offline iPad web app for HSK 4 / HSK 5 (3.0) writing, speaking, paragraph ordering and reading.
Open once online, add to Home Screen, and it runs with no network. Attempts and recordings are stored on the device.

- Content: `content/*.json` (add items there, then run `python3 -I tools/build_sw.py`)
- Speaking audio: pre-generated with Fish Audio (`tools/gen_audio.py`), in `audio/`
- Dictionary: CC-CEDICT, CC BY-SA 4.0, © MDBG (`content/dict.json`)
- HSK 3.0 word lists: drkameleon/complete-hsk-vocabulary (`content/levels.json`)
- 散文 texts: public domain, from zh.wikisource.org
