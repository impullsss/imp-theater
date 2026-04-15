# Imp Theater

Documentation: [Russian](README.ru.md) | [English](README.en.md)

Author: Impullsss

A system-agnostic module for Foundry VTT. It adds a shared Theater window where the GM can run direct media or a YouTube embed while clients receive synchronized play, pause, stop, and seek commands.

Imp Theater does not proxy YouTube content through the GM. In YouTube embed mode every player still needs direct access to YouTube; the module only synchronizes player controls.

## Features

- Opens a shared Theater window.
- The GM sets the source URL, title, source type, and media type.
- Supports direct media: Foundry files, `.mp4`, `.webm`, `.mp3`, `.ogg`, `.wav`, and similar direct links.
- Supports YouTube embed sync if clients can open YouTube.
- Synchronizes play, pause, stop, seek, and manual Sync.
- Players can change their own local volume.
- Adds a small Theater button on the canvas.
- Includes EN/RU localization.

## Console API

```js
game.impTheater.open();       // open Theater
game.impTheater.toggle();     // open or hide Theater
game.impTheater.state();      // get current room state
```

## Settings

- `Show Imp Theater launcher` - client setting for the Theater button.
- `Open when playback starts` - client setting for auto-opening when the GM starts playback.
- `Sync tolerance in seconds` - client setting for direct media.
