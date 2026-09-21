'use strict'
// ============================================================================
// speechPack/manifest.js - the Speech Pack add-on: whisper.cpp + Whisper models.
// ----------------------------------------------------------------------------
// Every URL is pinned (a release tag / a Hugging Face commit, never "latest" or "main") and
// every download has its exact size and SHA-256 recorded here. Values were read on 2026-09-21
// from GitHub's published release-asset digests and Hugging Face's LFS object ids:
//
//   whisper.cpp release v1.9.2   https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2
//   models                       https://huggingface.co/ggerganov/whisper.cpp  @ 5359861c739e955e79d9a303bcbc70fb988958b1
//
// Licences: whisper.cpp = MIT; OpenAI Whisper weights = MIT (the model card says license: mit);
// SDL2.dll inside the Windows archive = zlib. Texts: THIRD_PARTY_LICENSES/SPEECH-PACK-NOTICE.md.
// To update: change the version/URL/size/sha256 together, re-run test/addons-manifest.test.js.
// ============================================================================

const WHISPER_TAG = 'v1.9.2'
const RELEASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}`
const HF_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1'
const HF = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${HF_COMMIT}`

// id -> { file, size, sha256 (of the file), english-only?, label, about }
const MODELS = [
  { key: 'tiny.en', file: 'ggml-tiny.en.bin', size: 77704715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f', name: 'Tiny - English', english: true, speed: 'fastest', accuracy: 'basic' },
  { key: 'tiny', file: 'ggml-tiny.bin', size: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', name: 'Tiny - many languages', english: false, speed: 'fastest', accuracy: 'basic' },
  { key: 'base.en', file: 'ggml-base.en.bin', size: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', name: 'Base - English', english: true, speed: 'fast', accuracy: 'good (recommended)' },
  { key: 'base', file: 'ggml-base.bin', size: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', name: 'Base - many languages', english: false, speed: 'fast', accuracy: 'good' },
  { key: 'small.en', file: 'ggml-small.en.bin', size: 487614201, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d', name: 'Small - English', english: true, speed: 'slower', accuracy: 'better' },
  { key: 'small', file: 'ggml-small.bin', size: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', name: 'Small - many languages', english: false, speed: 'slower', accuracy: 'better' }
]

const modelComponents = MODELS.map((m) => ({
  id: `model-${m.key}`,
  name: `${m.name} (${Math.round(m.size / 1048576)} MB)`,
  kind: 'file',
  group: 'model',
  required: false,
  platform: 'any',
  version: 'ggml-2024-10',
  licence: 'MIT (OpenAI Whisper weights)',
  url: `${HF}/${m.file}`,
  size: m.size,
  sha256: m.sha256,
  fileName: m.file,
  info: { modelKey: m.key, english: m.english, multilingual: !m.english, speed: m.speed, accuracy: m.accuracy }
}))

const SPEECH_PACK = {
  schema: 1,
  id: 'speech-pack',
  name: 'Speech Pack',
  summary: 'Make subtitles for titles that have none, on this PC. Private: audio never leaves your computer.',
  description:
    'Uses whisper.cpp with an OpenAI Whisper model to listen to a movie or episode and write an English or ' +
    'translated subtitle file next to it. It works quietly in the background, pauses while anyone is watching, ' +
    'converting, or the PC is on battery, and labels every file "AI-generated". Pick at least one model to download.',
  version: '1',
  publisher: 'Beebo Entertainment',
  homepage: 'https://github.com/ggml-org/whisper.cpp',
  licence: 'MIT (whisper.cpp and OpenAI Whisper models); SDL2.dll: zlib',
  licenceFiles: ['SPEECH-PACK-NOTICE.md', 'WHISPER-CPP-MIT.txt', 'OPENAI-WHISPER-MIT.txt', 'SDL2-ZLIB.txt'],
  allowedHosts: ['github.com', '*.githubusercontent.com', 'huggingface.co', '*.huggingface.co', '*.hf.co'],
  components: [
    {
      id: 'engine',
      name: 'whisper.cpp speech engine (Windows, 64-bit)',
      kind: 'archive',
      group: 'engine',
      required: true,
      platform: 'win32-x64',
      version: WHISPER_TAG,
      licence: 'MIT',
      url: `${RELEASE}/whisper-bin-x64.zip`,
      size: 8194445,
      sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a',
      format: 'zip',
      extract: ['whisper-cli.exe', '*.dll'],
      executable: 'whisper-cli.exe',
      unpackedMaxBytes: 80 * 1024 * 1024
    },
    {
      id: 'engine',
      name: 'whisper.cpp speech engine (Linux, 64-bit)',
      kind: 'archive',
      group: 'engine',
      required: true,
      platform: 'linux-x64',
      version: WHISPER_TAG,
      licence: 'MIT',
      url: `${RELEASE}/whisper-bin-ubuntu-x64.tar.gz`,
      size: 9497583,
      sha256: '46811a3ecf584307480a220b9ef5ff81b7b22dc41577cbc274ce3afc61f753b1',
      format: 'tar.gz',
      extract: ['whisper-cli', '*.so', '*.so.*'],
      executable: 'whisper-cli',
      unpackedMaxBytes: 160 * 1024 * 1024
    },
    ...modelComponents
  ]
}

module.exports = { SPEECH_PACK, MODELS, WHISPER_TAG, HF_COMMIT, ADDON_ID: 'speech-pack' }
