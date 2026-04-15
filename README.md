# Imp Theater

Документация: [русский](README.ru.md) | [English](README.en.md)

Автор: Impullsss

System-agnostic module для Foundry VTT. Он добавляет общее окно Theater, где GM может запускать direct media или YouTube embed, а клиенты получают синхронизированные play, pause, stop и seek.

Imp Theater не проксирует YouTube-контент через GM. В режиме YouTube embed каждый игрок должен иметь прямой доступ к YouTube; модуль синхронизирует только управление плеером.

## Что умеет

- Открывает окно общего Theater.
- GM задаёт source URL, title, source type и media type.
- Поддерживает direct media: Foundry files, `.mp4`, `.webm`, `.mp3`, `.ogg`, `.wav` и похожие прямые ссылки.
- Поддерживает YouTube embed sync, если клиенты могут открыть YouTube.
- Синхронизирует play, pause, stop, seek и ручной Sync.
- Игроки могут менять свою local volume.
- Есть маленькая кнопка Theater на canvas.
- Есть RU/EN локализация.

## Console API

```js
game.impTheater.open();       // открыть Theater
game.impTheater.toggle();     // открыть или скрыть Theater
game.impTheater.state();      // получить текущее состояние комнаты
```

## Настройки

- `Показывать кнопку Imp Theater` - client setting для кнопки Theater.
- `Открывать окно при старте воспроизведения` - client setting для автооткрытия, когда GM запускает playback.
- `Допуск синхронизации в секундах` - client setting для direct media.
