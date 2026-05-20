# Fiverr AI Reply Drafter

Chrome extension that drafts Fiverr inbox replies using OpenRouter models, with optional long-term memory via Mem0.

## Features

- Adds an **AI Reply** button in Fiverr inbox conversations.
- Reads conversation context (Fiverr internal API first, DOM fallback).
- Drafts professional replies using your selected OpenRouter model.
- Optional extraction of public links shared by clients (Google Docs/Sheets/Slides, web pages, limited PDF text extraction).
- Per-client memory support:
  - Local Chrome storage by buyer username.
  - Optional Mem0 integration with per-client namespacing.
- Optional debug mode with recent execution logs in popup.

## Requirements

- Google Chrome (Manifest V3 extension support).
- OpenRouter API key.
- (Optional) Mem0 API key for cloud memory.

## Installation (Unpacked Extension)

1. Clone or download this repository.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository root folder (the folder containing `manifest.json`).

## Setup

1. Open the extension popup.
2. Set:
   - **OpenRouter API Key**
   - **OpenRouter Model** (loaded live from OpenRouter `/models`)
   - **Persona / Rules** (optional)
3. Optional toggles:
   - **Read public client links/docs**
   - **Debug mode**
   - **Use Mem0 AI memory**
4. If Mem0 is enabled, provide:
   - **Mem0 API Key**
   - **Mem0 Base User ID** (auto-scoped per Fiverr buyer as `base-id::buyer-username`)
5. Click **Save Settings**.

## Usage

1. Open a Fiverr inbox conversation.
2. Click **AI Reply**.
3. The extension drafts a reply and inserts it into the message box.
4. If insertion fails, the reply is copied to clipboard.

## Permissions and Network Access

The extension requests:

- `storage`, `activeTab`, `scripting`
- Host access for Fiverr, OpenRouter, Mem0, plus general `http/https` hosts (used for optional link processing).

External APIs used:

- OpenRouter models endpoint: `https://openrouter.ai/api/v1/models`
- OpenRouter chat endpoint: `https://openrouter.ai/api/v1/chat/completions`
- Mem0 endpoints (optional): `https://api.mem0.ai/v3/memories/search/` and `/add/`

## Notes

- This tool drafts messages; review before sending.
- Link processing only works for publicly readable/shared resources.
- If Mem0 is unavailable, local memory fallback is used.
