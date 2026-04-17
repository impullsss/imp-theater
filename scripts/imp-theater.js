const IMP_THEATER_MODULE_ID = "imp-theater";
const IMP_THEATER_MODULE_PATH = document.currentScript?.src?.match(/\/modules\/([^/]+)\//)?.[1] ?? IMP_THEATER_MODULE_ID;
const IMP_THEATER_SOCKET = `module.${IMP_THEATER_MODULE_ID}`;
const IMP_THEATER_VOLUME_MAX = 2;
let impTheaterTransientState = null;
let impTheaterYoutubeApiPromise = null;

function impTheaterT(key) {
  return game.i18n.localize(`IMPTHEATER.${key}`);
}

function impTheaterDefaultState() {
  return {
    sourceUrl: "",
    sourceType: "direct",
    mediaKind: "video",
    title: "",
    playlists: [],
    activePlaylistId: "",
    playingPlaylistId: "",
    playlistIndex: -1,
    globalVolume: 1,
    uiRevision: 0,
    playing: false,
    position: 0,
    updatedAt: Date.now()
  };
}

function impTheaterState() {
  const state = foundry.utils.deepClone(impTheaterTransientState || game.settings.get(IMP_THEATER_MODULE_ID, "roomState") || {});
  return foundry.utils.mergeObject(impTheaterDefaultState(), state, { inplace: false });
}

function impTheaterCurrentPosition(state = impTheaterState()) {
  const base = Number(state.position || 0);
  if (!state.playing) return base;
  return Math.max(0, base + ((Date.now() - Number(state.updatedAt || Date.now())) / 1000));
}

function impTheaterSourceKey(state = impTheaterState()) {
  return [
    state.sourceUrl || "",
    state.sourceType || "",
    state.mediaKind || "",
    state.title || ""
  ].join("\u001f");
}

function impTheaterId() {
  return foundry.utils.randomID?.() || Math.random().toString(36).slice(2, 12);
}

function impTheaterEscape(value) {
  const element = document.createElement("span");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function impTheaterLoadYoutubeApi() {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  if (impTheaterYoutubeApiPromise) return impTheaterYoutubeApiPromise;

  impTheaterYoutubeApiPromise = new Promise((resolve) => {
    const previousReady = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve(globalThis.YT);
    };

    if (!document.querySelector("script[src='https://www.youtube.com/iframe_api']")) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
  });

  return impTheaterYoutubeApiPromise;
}

function impTheaterDetectSourceType(url) {
  return impTheaterYoutubeId(url) ? "youtube" : "direct";
}

function impTheaterDetectMediaKind(url) {
  const cleanUrl = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  if (/\.(mp3|ogg|wav|flac|m4a|aac)$/i.test(cleanUrl)) return "audio";
  return "video";
}

function impTheaterYoutubeId(url) {
  const text = String(url || "").trim();
  if (!text) return "";

  try {
    const parsed = new URL(text);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] || "";
    if (host.endsWith("youtube.com")) {
      if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) return parts[1] || "";
    }
  } catch {
    const match = text.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([\w-]{6,})/i);
    return match?.[1] || "";
  }

  return "";
}

async function impTheaterYoutubeTitle(url) {
  const videoId = impTheaterYoutubeId(url);
  if (!videoId) return "";

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
    if (!response.ok) return "";
    const data = await response.json();
    return String(data?.title || "").trim();
  } catch {
    return "";
  }
}

async function impTheaterSetState(nextState, { emit = true } = {}) {
  const state = foundry.utils.mergeObject(impTheaterDefaultState(), nextState, { inplace: false });
  state.position = Math.max(0, Number(state.position || 0));
  state.updatedAt = Number(state.updatedAt || Date.now());
  impTheaterTransientState = foundry.utils.deepClone(state);
  await game.settings.set(IMP_THEATER_MODULE_ID, "roomState", state);
  if (emit) game.socket.emit(IMP_THEATER_SOCKET, { action: "state", state });
}

class ImpTheaterWindow extends Application {
  constructor(options = {}) {
    super(options);
    this._youtubeReady = false;
    this._lastYoutubeCommandAt = 0;
    this._youtubeApplyTimers = [];
    this._youtubePlayer = null;
    this._youtubePlayerFrame = null;
    this._youtubePlayerVideoId = "";
    this._youtubeLastKnownTime = 0;
    this._youtubeGMSyncTimer = null;
    this._youtubeVolumePollTimer = null;
    this._titleLookupTimer = null;
    this._globalVolumeSaveTimer = null;
    this._windowStateSaveTimer = null;
    this._restoredWindowState = false;
    this._applyingLocalVolume = false;
    this._onEdgeMouseMove = this._onEdgeMouseMove.bind(this);
    this._onEdgeMouseLeave = this._onEdgeMouseLeave.bind(this);
    this._onEdgeMouseDown = this._onEdgeMouseDown.bind(this);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "imp-theater-window",
      classes: ["imp-theater-window"],
      template: `modules/${IMP_THEATER_MODULE_PATH}/templates/theater-window.hbs`,
      title: "Imp Theater",
      width: 720,
      height: 640,
      resizable: false,
      minimizable: true,
      popOut: true
    });
  }

  async getData() {
    const state = impTheaterState();
    const sourceType = state.sourceType || "direct";
    const mediaKind = state.mediaKind || "video";
    const youtubeId = impTheaterYoutubeId(state.sourceUrl);
    const isYoutube = sourceType === "youtube" && Boolean(youtubeId);
    const isAudio = !isYoutube && mediaKind === "audio";
    const displayTitle = state.title || (state.sourceUrl ? impTheaterT("UI.Untitled") : impTheaterT("UI.NoSource"));
    const statusText = state.playing ? impTheaterT("UI.Playing") : impTheaterT("UI.Paused");
    const playlists = state.playlists || [];
    const activePlaylist = playlists.find((playlist) => playlist.id === state.activePlaylistId) || playlists[0] || null;

    return {
      state,
      canControl: game.user?.isGM,
      hasSource: Boolean(state.sourceUrl),
      displayTitle,
      statusText,
      isYoutube,
      isAudio,
      playlists: playlists.map((playlist) => ({ ...playlist, selected: playlist.id === activePlaylist?.id })),
      hasPlaylists: Boolean(playlists.length),
      activePlaylist,
      activePlaylistItems: (activePlaylist?.items || []).map((item, index) => ({
        ...item,
        isPlaying: activePlaylist?.id === state.playingPlaylistId && index === state.playlistIndex
      })),
      hasActivePlaylistItems: Boolean(activePlaylist?.items?.length),
      youtubeEmbedUrl: isYoutube ? this._youtubeEmbedUrl(youtubeId) : "",
      localVolume: this._normalizeVolumeMultiplier(game.settings.get(IMP_THEATER_MODULE_ID, "localVolume")),
      globalVolume: this._normalizeVolumeMultiplier(state.globalVolume),
      sourceTypeAuto: sourceType === "auto",
      sourceTypeDirect: sourceType === "direct",
      sourceTypeYoutube: sourceType === "youtube",
      mediaKindAuto: mediaKind === "auto",
      mediaKindVideo: mediaKind === "video",
      mediaKindAudio: mediaKind === "audio"
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    const root = this._htmlRoot(html);
    if (!root) return;

    root.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-action]");
      if (!button || !root.contains(button)) return;

      const action = button.dataset.action;
      if (action === "close") {
        event.preventDefault();
        this.hide();
        return;
      }

      if (!game.user?.isGM) return;
      event.preventDefault();

      if (action === "play") await this._setPlayback(true);
      if (action === "pause") await this._setPlayback(false);
      if (action === "stop") await this._stopPlayback();
      if (action === "sync") await this._syncPlayback();
      if (action === "previous") await this._playPreviousPlaylistItem();
      if (action === "next") await this._playNextPlaylistItem();
      if (action === "create-playlist") await this._createPlaylist(root);
      if (action === "delete-playlist") await this._deleteActivePlaylist(root);
      if (action === "add-playlist") await this._addCurrentToPlaylist(root);
      if (action === "play-playlist") await this._playPlaylistItem(Number(button.dataset.index));
      if (action === "remove-playlist") await this._removePlaylistItem(Number(button.dataset.index));
    });

    root.addEventListener("change", async (event) => {
      if (!event.target.matches("[name='activePlaylistId']")) return;
      if (!game.user?.isGM) return;
      const state = impTheaterState();
      await impTheaterSetState({
        ...state,
        activePlaylistId: event.target.value,
        uiRevision: Number(state.uiRevision || 0) + 1,
        updatedAt: Date.now()
      });
    });

    root.querySelector("[data-action='volume']")?.addEventListener("input", async (event) => {
      const volume = this._normalizeVolumeMultiplier(event.currentTarget.value);
      await game.settings.set(IMP_THEATER_MODULE_ID, "localVolume", volume);
      this._applyLocalVolume(volume);
    });

    root.querySelector("[data-action='global-volume']")?.addEventListener("input", async (event) => {
      await this._setGlobalVolume(event.currentTarget.value);
    });

    const sourceInput = root.querySelector("[name='sourceUrl']");
    sourceInput?.addEventListener("input", () => this._handleSourceInput(root));
    sourceInput?.addEventListener("change", () => this._handleSourceInput(root, 0));
    sourceInput?.addEventListener("blur", () => this._handleSourceInput(root, 0));

    const media = this._mediaElement();
    media?.addEventListener("error", () => {
      ui.notifications.warn(impTheaterT("Notifications.MediaError"));
    });

    this._youtubeFrame()?.addEventListener("load", () => {
      this._prepareYoutubePlayer();
      this._scheduleYoutubeApply();
      this._applyLocalVolume();
    });

    this._applyState();
  }

  async _render(force, options) {
    await super._render(force, options);
    this._bindEdgeResize();
    if (!this._restoredWindowState) {
      this._restoredWindowState = true;
      window.setTimeout(() => this._restoreWindowState(), 0);
    }
    ImpTheaterManager.lastRenderedSourceKey = impTheaterSourceKey();
    const state = impTheaterState();
    ImpTheaterManager.lastRenderedUiRevision = state.uiRevision ?? 0;
    ImpTheaterManager.lastRenderedGlobalVolume = Number(state.globalVolume ?? 0.8);
    this._applyHiddenClass();
    this._ensureResizeHandle();
    this._prepareYoutubePlayer();
    window.setTimeout(() => this._applyState(), 50);
    ImpTheaterManager.updateLauncher();
  }

  async close(options = {}) {
    if (!options.force) {
      this.hide();
      return this;
    }

    const result = await super.close(options);
    ImpTheaterManager.updateLauncher();
    return result;
  }

  hide() {
    ImpTheaterManager.hidden = true;
    this._applyHiddenClass();
    ImpTheaterManager.updateLauncher();
  }

  show() {
    ImpTheaterManager.hidden = false;
    this._applyHiddenClass();
    this.bringToTop?.();
    ImpTheaterManager.updateLauncher();
  }

  _applyHiddenClass() {
    const element = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    element?.classList.toggle("imp-theater-window-hidden", Boolean(ImpTheaterManager.hidden));
  }

  _htmlRoot(html) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    return this.element instanceof HTMLElement ? this.element : this.element?.[0];
  }



  _getWindowElement() {
    const element = this.element;
    if (element instanceof HTMLElement) return element;
    if (element?.[0] instanceof HTMLElement) return element[0];
    return document.getElementById(this.options.id);
  }

  setPosition(position = {}) {
    const result = super.setPosition(position);
    this._scheduleWindowStateSave();
    return result;
  }

  _restoreWindowState() {
    const state = game.settings.get(IMP_THEATER_MODULE_ID, "windowState") || {};
    const position = state.position || {};
    if (!Object.keys(position).length) return;
    this.setPosition(position);
  }

  _scheduleWindowStateSave() {
    if (!this.rendered) return;
    window.clearTimeout(this._windowStateSaveTimer);
    this._windowStateSaveTimer = window.setTimeout(() => this._saveWindowStateNow(), 250);
  }

  async _saveWindowStateNow() {
    const element = this._getWindowElement();
    const rect = element?.getBoundingClientRect();
    const position = {
      left: this.position?.left ?? rect?.left,
      top: this.position?.top ?? rect?.top,
      width: this.position?.width ?? rect?.width,
      height: this.position?.height ?? rect?.height
    };
    await game.settings.set(IMP_THEATER_MODULE_ID, "windowState", { position });
  }

  _bindEdgeResize() {
    const element = this._getWindowElement();
    if (!element || element.dataset.impTheaterEdgeResizeBound) return;
    element.dataset.impTheaterEdgeResizeBound = "1";
    element.addEventListener("mousemove", this._onEdgeMouseMove);
    element.addEventListener("mouseleave", this._onEdgeMouseLeave);
    element.addEventListener("mousedown", this._onEdgeMouseDown);
  }

  _onEdgeMouseMove(event) {
    const element = this._getWindowElement();
    if (!element || this._edgeResizing) return;
    element.style.cursor = this._cursorForEdges(this._resizeEdgesFromEvent(event, element));
  }

  _onEdgeMouseLeave() {
    const element = this._getWindowElement();
    if (!element || this._edgeResizing) return;
    element.style.cursor = "";
  }

  _onEdgeMouseDown(event) {
    const element = this._getWindowElement();
    if (!element || event.button !== 0) return;
    const edges = this._resizeEdgesFromEvent(event, element);
    if (!edges) return;
    event.preventDefault();
    event.stopPropagation();
    this._startEdgeResize(event, edges);
  }

  _resizeEdgesFromEvent(event, element) {
    if (event.target.closest(".imp-theater-resize-handle")) return "se";
    if (event.target.closest("button, input, select, textarea, iframe, video, audio")) return "";
    const rect = element.getBoundingClientRect();
    const threshold = 8;
    let edges = "";
    if (event.clientY - rect.top <= threshold) edges += "n";
    if (rect.bottom - event.clientY <= threshold) edges += "s";
    if (event.clientX - rect.left <= threshold) edges += "w";
    if (rect.right - event.clientX <= threshold) edges += "e";
    return edges;
  }

  _cursorForEdges(edges) {
    if (!edges) return "";
    if (["ne", "sw"].includes(edges)) return "nesw-resize";
    if (["nw", "se"].includes(edges)) return "nwse-resize";
    if (edges.includes("e") || edges.includes("w")) return "ew-resize";
    if (edges.includes("n") || edges.includes("s")) return "ns-resize";
    return "";
  }

  _startEdgeResize(event, edges) {
    const element = this._getWindowElement();
    if (!element) return;

    this._edgeResizing = true;
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = element.getBoundingClientRect();
    const minWidth = 420;
    const minHeight = 360;

    const move = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      let left = rect.left;
      let top = rect.top;
      let width = rect.width;
      let height = rect.height;

      if (edges.includes("e")) width = Math.max(minWidth, rect.width + dx);
      if (edges.includes("w")) {
        width = Math.max(minWidth, rect.width - dx);
        left = rect.right - width;
      }
      if (edges.includes("s")) height = Math.max(minHeight, rect.height + dy);
      if (edges.includes("n")) {
        height = Math.max(minHeight, rect.height - dy);
        top = rect.bottom - height;
      }

      this.setPosition({ left, top, width, height });
    };

    const stop = () => {
      this._edgeResizing = false;
      element.style.cursor = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
      this._saveWindowStateNow();
    };

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
  }

  _ensureResizeHandle() {
    const element = this._getWindowElement();
    if (!element || element.querySelector(".imp-theater-resize-handle")) return;

    const handle = document.createElement("div");
    handle.className = "imp-theater-resize-handle";
    handle.title = "Resize";
    element.appendChild(handle);
  }

  _mediaElement() {
    const element = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    return element?.querySelector(".imp-theater-media") || null;
  }

  _youtubeFrame() {
    const element = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    return element?.querySelector(".imp-theater-youtube") || null;
  }

  _isYoutubeState(state = impTheaterState()) {
    return state.sourceType === "youtube" && Boolean(impTheaterYoutubeId(state.sourceUrl));
  }

  async _prepareYoutubePlayer() {
    const state = impTheaterState();
    if (!this._isYoutubeState(state)) return;

    const iframe = this._youtubeFrame();
    const videoId = impTheaterYoutubeId(state.sourceUrl);
    if (!iframe || !videoId) return;
    if (this._youtubePlayer && this._youtubePlayerFrame === iframe && this._youtubePlayerVideoId === videoId) return;

    this._youtubeReady = false;
    this._youtubePlayer = null;
    this._youtubePlayerFrame = iframe;
    this._youtubePlayerVideoId = videoId;

    const YT = await impTheaterLoadYoutubeApi();
    if (!this.rendered || this._youtubeFrame() !== iframe) return;

    this._youtubePlayer = new YT.Player(iframe.id, {
      events: {
        onReady: () => {
          this._youtubeReady = true;
          this._applyLocalVolume();
          this._startYoutubeVolumePolling();
          this._scheduleYoutubeApply();
        },
        onStateChange: () => {
          this._captureYoutubeCurrentTime();
          this._scheduleYoutubeGMSyncFromPlayer();
        }
      }
    });
  }

  _youtubeEmbedUrl(id) {
    const params = new URLSearchParams({
      enablejsapi: "1",
      rel: "0",
      modestbranding: "1",
      playsinline: "1"
    });
    if (globalThis.location?.origin) params.set("origin", globalThis.location.origin);
    return `https://www.youtube.com/embed/${encodeURIComponent(id)}?${params.toString()}`;
  }

  _currentPositionFromPlayer() {
    const state = impTheaterState();
    if (this._isYoutubeState(state)) {
      const youtubeTime = this._captureYoutubeCurrentTime();
      if (Number.isFinite(youtubeTime)) return youtubeTime;
      if (Number.isFinite(this._youtubeLastKnownTime)) return this._youtubeLastKnownTime;
    }

    const media = this._mediaElement();
    if (media && Number.isFinite(media.currentTime)) return media.currentTime;
    return impTheaterCurrentPosition(state);
  }

  _captureYoutubeCurrentTime() {
    try {
      const time = this._youtubePlayer?.getCurrentTime?.();
      if (Number.isFinite(time)) {
        this._youtubeLastKnownTime = time;
        return time;
      }
    } catch {
      return null;
    }

    return null;
  }

  _refreshLists(state = impTheaterState()) {
    if (!this.rendered) return;

    const element = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    if (!element) return;

    const playlists = state.playlists || [];
    const activePlaylist = playlists.find((playlist) => playlist.id === state.activePlaylistId) || playlists[0] || null;
    const activeItems = activePlaylist?.items || [];

    const playlistsRoot = element.querySelector(".imp-theater-playlists");
    if (playlistsRoot) {
      playlistsRoot.innerHTML = `
        <h3>${impTheaterEscape(impTheaterT("UI.Playlists"))}</h3>
        <div class="imp-theater-playlist-tools">
          <input type="text" name="playlistName" placeholder="${impTheaterEscape(impTheaterT("UI.PlaylistName"))}">
          <button type="button" data-action="create-playlist">
            <i class="fas fa-folder-plus"></i> ${impTheaterEscape(impTheaterT("UI.CreatePlaylist"))}
          </button>
        </div>
        <div class="imp-theater-playlist-tools">
          <select name="activePlaylistId">
            ${playlists.length ? playlists.map((playlist) => `
              <option value="${impTheaterEscape(playlist.id)}" ${playlist.id === activePlaylist?.id ? "selected" : ""}>${impTheaterEscape(playlist.name)}</option>
            `).join("") : `<option value="">${impTheaterEscape(impTheaterT("UI.NoPlaylists"))}</option>`}
          </select>
          <button type="button" data-action="add-playlist" ${playlists.length ? "" : "disabled"}>
            <i class="fas fa-plus"></i> ${impTheaterEscape(impTheaterT("UI.AddPlaylist"))}
          </button>
          <button type="button" data-action="delete-playlist" ${playlists.length ? "" : "disabled"}>
            <i class="fas fa-trash"></i> ${impTheaterEscape(impTheaterT("UI.DeletePlaylist"))}
          </button>
        </div>
        ${activeItems.length ? `
          <ol>
            ${activeItems.map((item, index) => `
              <li class="${activePlaylist?.id === state.playingPlaylistId && index === state.playlistIndex ? "is-playing" : ""}">
                <span>${impTheaterEscape(item.title || item.sourceUrl)}</span>
                <button type="button" data-action="play-playlist" data-index="${index}" title="${impTheaterEscape(impTheaterT("UI.PlayPlaylist"))}">
                  <i class="fas fa-play"></i>
                </button>
                <button type="button" data-action="remove-playlist" data-index="${index}" title="${impTheaterEscape(impTheaterT("UI.RemovePlaylist"))}">
                  <i class="fas fa-trash"></i>
                </button>
              </li>
            `).join("")}
          </ol>
        ` : `<p>${impTheaterEscape(impTheaterT("UI.PlaylistEmpty"))}</p>`}
        <div class="imp-theater-playlist-nav">
          <button type="button" data-action="play">
            <i class="fas fa-play"></i> ${impTheaterEscape(impTheaterT("UI.Play"))}
          </button>
          <button type="button" data-action="pause">
            <i class="fas fa-pause"></i> ${impTheaterEscape(impTheaterT("UI.Pause"))}
          </button>
          <button type="button" data-action="stop">
            <i class="fas fa-stop"></i> ${impTheaterEscape(impTheaterT("UI.Stop"))}
          </button>
          <button type="button" data-action="sync">
            <i class="fas fa-arrows-rotate"></i> ${impTheaterEscape(impTheaterT("UI.Sync"))}
          </button>
          <button type="button" data-action="previous" ${activeItems.length ? "" : "disabled"}>
            <i class="fas fa-backward-step"></i> ${impTheaterEscape(impTheaterT("UI.Previous"))}
          </button>
          <button type="button" data-action="next" ${activeItems.length ? "" : "disabled"}>
            <i class="fas fa-forward-step"></i> ${impTheaterEscape(impTheaterT("UI.Next"))}
          </button>
        </div>
      `;
    }

    ImpTheaterManager.lastRenderedUiRevision = state.uiRevision ?? 0;
  }

  async _playlistItemFromFormData(data) {
    const rawUrl = String(data.get("sourceUrl") || "").trim();
    if (!rawUrl) {
      ui.notifications.warn(impTheaterT("Notifications.SourceRequired"));
      return null;
    }

    let sourceType = String(data.get("sourceType") || "youtube");
    if (sourceType === "auto") sourceType = impTheaterDetectSourceType(rawUrl);

    let mediaKind = String(data.get("mediaKind") || "video");
    if (mediaKind === "auto") mediaKind = sourceType === "youtube" ? "video" : impTheaterDetectMediaKind(rawUrl);

    const item = {
      sourceUrl: rawUrl,
      sourceType,
      mediaKind,
      title: String(data.get("title") || "").trim()
    };

    return this._resolveItemTitle(item);
  }

  async _resolveItemTitle(item) {
    if (item.title || item.sourceType !== "youtube") return item;
    const title = await impTheaterYoutubeTitle(item.sourceUrl);
    return title ? { ...item, title } : item;
  }

  _handleSourceInput(root, delay = 650) {
    const titleInput = root.querySelector("[name='title']");
    if (titleInput?.dataset.autoTitle && titleInput.value === titleInput.dataset.autoTitle) {
      titleInput.value = "";
      delete titleInput.dataset.autoTitle;
    }
    this._scheduleTitleLookup(root, delay);
  }

  _scheduleTitleLookup(root, delay = 650) {
    if (!game.user?.isGM) return;
    window.clearTimeout(this._titleLookupTimer);
    this._titleLookupTimer = window.setTimeout(() => this._fillTitleFromUrl(root), delay);
  }

  async _fillTitleFromUrl(root) {
    const sourceInput = root.querySelector("[name='sourceUrl']");
    const titleInput = root.querySelector("[name='title']");
    const sourceUrl = String(sourceInput?.value || "").trim();
    if (!sourceUrl || String(titleInput?.value || "").trim()) return;

    const title = await impTheaterYoutubeTitle(sourceUrl);
    if (!title) return;
    if (String(sourceInput?.value || "").trim() !== sourceUrl) return;
    if (String(titleInput?.value || "").trim()) return;
    titleInput.value = title;
    titleInput.dataset.autoTitle = title;
  }

  _clearPendingTrackForm(root) {
    const form = root.closest("form") || root;
    const sourceInput = form.querySelector("[name='sourceUrl']");
    const titleInput = form.querySelector("[name='title']");
    if (sourceInput) sourceInput.value = "";
    if (titleInput) {
      titleInput.value = "";
      delete titleInput.dataset.autoTitle;
    }
  }

  async _loadMediaItem(item, overrides = {}) {
    const state = impTheaterState();
    await impTheaterSetState({
      ...state,
      ...item,
      ...overrides
    });
  }

  async _setPlayback(playing) {
    const state = impTheaterState();
    if (!state.sourceUrl) return;
    await impTheaterSetState({
      ...state,
      playing,
      position: this._currentPositionFromPlayer(),
      updatedAt: Date.now()
    });
  }

  async _stopPlayback() {
    const state = impTheaterState();
    await impTheaterSetState({
      ...state,
      playing: false,
      position: 0,
      updatedAt: Date.now()
    });
  }

  async _syncPlayback() {
    const state = impTheaterState();
    await impTheaterSetState({
      ...state,
      position: this._currentPositionFromPlayer(),
      updatedAt: Date.now()
    });
  }

  _activePlaylist(state = impTheaterState(), root = null) {
    const selected = root?.querySelector("[name='activePlaylistId']")?.value || state.activePlaylistId;
    const playlists = state.playlists || [];
    return playlists.find((playlist) => playlist.id === selected) || playlists[0] || null;
  }

  async _createPlaylist(root) {
    const input = root.querySelector("[name='playlistName']");
    const name = String(input?.value || "").trim();
    if (!name) {
      ui.notifications.warn(impTheaterT("Notifications.PlaylistNameRequired"));
      return;
    }

    const state = impTheaterState();
    const playlist = { id: impTheaterId(), name, items: [] };
    await impTheaterSetState({
      ...state,
      playlists: [...(state.playlists || []), playlist],
      activePlaylistId: playlist.id,
      playlistIndex: -1,
      uiRevision: Number(state.uiRevision || 0) + 1,
      updatedAt: Date.now()
    });
  }

  async _deleteActivePlaylist(root) {
    const state = impTheaterState();
    const active = this._activePlaylist(state, root);
    if (!active) return;

    const playlists = (state.playlists || []).filter((playlist) => playlist.id !== active.id);
    await impTheaterSetState({
      ...state,
      playlists,
      activePlaylistId: playlists[0]?.id || "",
      playingPlaylistId: state.playingPlaylistId === active.id ? "" : state.playingPlaylistId,
      playlistIndex: state.playingPlaylistId === active.id ? -1 : state.playlistIndex,
      uiRevision: Number(state.uiRevision || 0) + 1,
      updatedAt: Date.now()
    });
  }

  async _addCurrentToPlaylist(root) {
    const form = root.closest("form") || root;
    const item = await this._playlistItemFromFormData(new FormData(form));
    if (!item) return;

    const state = impTheaterState();
    const active = this._activePlaylist(state, root);
    if (!active) {
      ui.notifications.warn(impTheaterT("Notifications.PlaylistRequired"));
      return;
    }

    const playlists = (state.playlists || []).map((playlist) => {
      if (playlist.id !== active.id) return playlist;
      return { ...playlist, items: [...(playlist.items || []), item] };
    });

    await impTheaterSetState({
      ...state,
      playlists,
      activePlaylistId: active.id,
      uiRevision: Number(state.uiRevision || 0) + 1,
      updatedAt: Date.now()
    });
    this._clearPendingTrackForm(root);
  }

  async _playPlaylistItem(index) {
    const state = impTheaterState();
    const active = this._activePlaylist(state);
    const item = active?.items?.[index];
    if (!item) return;

    await this._loadMediaItem(item, {
      activePlaylistId: active.id,
      playingPlaylistId: active.id,
      playlistIndex: index,
      playing: true,
      position: 0,
      updatedAt: Date.now()
    });
  }

  async _removePlaylistItem(index) {
    const state = impTheaterState();
    const active = this._activePlaylist(state);
    if (!active?.items?.[index]) return;

    const playlists = (state.playlists || []).map((playlist) => {
      if (playlist.id !== active.id) return playlist;
      const items = [...(playlist.items || [])];
      items.splice(index, 1);
      return { ...playlist, items };
    });

    let playlistIndex = Number(state.playlistIndex ?? -1);
    if (state.playingPlaylistId === active.id) {
      if (playlistIndex === index) playlistIndex = -1;
      else if (playlistIndex > index) playlistIndex -= 1;
    }

    await impTheaterSetState({
      ...state,
      playlists,
      playlistIndex,
      uiRevision: Number(state.uiRevision || 0) + 1,
      updatedAt: Date.now()
    });
  }

  async _playNextPlaylistItem() {
    const state = impTheaterState();
    const active = this._activePlaylist(state);
    const items = active?.items || [];
    if (!items.length) return;
    const current = active.id === state.playingPlaylistId && Number.isInteger(state.playlistIndex) ? state.playlistIndex : -1;
    await this._playPlaylistItem((current + 1 + items.length) % items.length);
  }

  async _playPreviousPlaylistItem() {
    const state = impTheaterState();
    const active = this._activePlaylist(state);
    const items = active?.items || [];
    if (!items.length) return;
    const current = active.id === state.playingPlaylistId && Number.isInteger(state.playlistIndex) && state.playlistIndex >= 0
      ? state.playlistIndex
      : 0;
    await this._playPlaylistItem((current - 1 + items.length) % items.length);
  }

  _effectiveVolume(localVolume = game.settings.get(IMP_THEATER_MODULE_ID, "localVolume"), state = impTheaterState()) {
    const local = this._normalizeVolumeMultiplier(localVolume);
    const global = this._normalizeVolumeMultiplier(state.globalVolume);
    return Math.min(1, local * global);
  }

  _normalizeVolumeMultiplier(value, fallback = 1) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(IMP_THEATER_VOLUME_MAX, Math.max(0, numeric));
  }

  _applyLocalVolume(volume = game.settings.get(IMP_THEATER_MODULE_ID, "localVolume"), state = impTheaterState()) {
    const safeVolume = this._effectiveVolume(volume, state);
    const media = this._mediaElement();
    if (media) media.volume = safeVolume;

    if (state.sourceType === "youtube") {
      this._applyingLocalVolume = true;
      this._youtubeCommand("setVolume", [Math.round(safeVolume * 100)]);
      this._youtubeCommand(safeVolume <= 0 ? "mute" : "unMute", []);
      window.setTimeout(() => {
        this._applyingLocalVolume = false;
      }, 500);
    }
  }

  _startYoutubeVolumePolling() {
    window.clearInterval(this._youtubeVolumePollTimer);
    this._youtubeVolumePollTimer = window.setInterval(() => {
      if (!this.rendered || !this._youtubeReady || this._applyingLocalVolume) return;

      let youtubeVolume;
      try {
        youtubeVolume = this._youtubePlayer?.getVolume?.();
      } catch {
        return;
      }

      if (!Number.isFinite(youtubeVolume)) return;
      const normalized = Math.min(1, Math.max(0, youtubeVolume / 100));
      const state = impTheaterState();
      const current = Number(game.settings.get(IMP_THEATER_MODULE_ID, "localVolume"));
      const expected = this._effectiveVolume(current, state);
      if (Math.abs(normalized - expected) < 0.02) return;

      const global = Math.max(0.01, this._normalizeVolumeMultiplier(state.globalVolume));
      const localFromYoutube = this._normalizeVolumeMultiplier(normalized / global);
      if (Math.abs(localFromYoutube - current) < 0.02) return;

      game.settings.set(IMP_THEATER_MODULE_ID, "localVolume", localFromYoutube);
      const slider = (this.element instanceof HTMLElement ? this.element : this.element?.[0])?.querySelector("[data-action='volume']");
      if (slider) slider.value = String(localFromYoutube);
    }, 1000);
  }

  _applyState() {
    if (!this.rendered) return;

    const state = impTheaterState();
    this._applyLocalVolume(undefined, state);

    if (state.sourceType === "youtube") {
      this._scheduleYoutubeApply(state);
      return;
    }

    const media = this._mediaElement();
    if (!media) return;

    const targetPosition = impTheaterCurrentPosition(state);
    const tolerance = game.settings.get(IMP_THEATER_MODULE_ID, "syncTolerance");
    if (Number.isFinite(targetPosition) && Math.abs((media.currentTime || 0) - targetPosition) > tolerance) {
      media.currentTime = targetPosition;
    }

    if (state.playing && media.paused) {
      media.play().catch(() => ui.notifications.info(impTheaterT("Notifications.ClickToPlay")));
    } else if (!state.playing && !media.paused) {
      media.pause();
    }
  }

  async _setGlobalVolume(volume) {
    if (!game.user?.isGM) return;
    const state = impTheaterState();
    const globalVolume = this._normalizeVolumeMultiplier(volume);
    this._applyLocalVolume(undefined, { ...state, globalVolume });
    impTheaterTransientState = foundry.utils.deepClone({ ...state, globalVolume });

    window.clearTimeout(this._globalVolumeSaveTimer);
    this._globalVolumeSaveTimer = window.setTimeout(async () => {
      await impTheaterSetState({
        ...impTheaterState(),
        globalVolume
      });
    }, 120);
  }

  _applyYoutubeState(state) {
    const position = impTheaterCurrentPosition(state);
    this._youtubeCommand("seekTo", [position, true]);
    this._youtubeCommand(state.playing ? "playVideo" : "pauseVideo", []);
  }

  _scheduleYoutubeApply(state = impTheaterState()) {
    for (const timer of this._youtubeApplyTimers) window.clearTimeout(timer);
    this._youtubeApplyTimers = [];
    const delays = [0, 450, 1200, 2500];
    for (const delay of delays) {
      const timer = window.setTimeout(() => {
        if (!this.rendered) return;
        this._applyYoutubeState(state);
      }, delay);
      this._youtubeApplyTimers.push(timer);
    }
  }

  _youtubeCommand(func, args = []) {
    if (this._youtubeReady && this._youtubePlayer && typeof this._youtubePlayer[func] === "function") {
      try {
        this._youtubePlayer[func](...args);
        return;
      } catch {
        // Fall back to postMessage below.
      }
    }

    const iframe = this._youtubeFrame();
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(JSON.stringify({
      event: "command",
      func,
      args
    }), "https://www.youtube.com");
  }

  _scheduleYoutubeGMSyncFromPlayer() {
    if (!game.user?.isGM) return;
    window.clearTimeout(this._youtubeGMSyncTimer);
    this._youtubeGMSyncTimer = window.setTimeout(async () => {
      const state = impTheaterState();
      if (!this._isYoutubeState(state) || !state.sourceUrl) return;

      const position = this._currentPositionFromPlayer();
      if (!Number.isFinite(position)) return;

      const expected = impTheaterCurrentPosition(state);
      if (Math.abs(position - expected) < 2) return;

      let playing = true;
      try {
        const playerState = this._youtubePlayer?.getPlayerState?.();
        if (playerState === 1) playing = true;
        if (playerState === 0) playing = false;
      } catch {
        // Seek gestures should resume players even when the iframe reports buffering.
      }

      await impTheaterSetState({
        ...state,
        playing,
        position,
        updatedAt: Date.now()
      });
    }, 700);
  }
}

const ImpTheaterManager = {
  app: null,
  hidden: false,
  lastRenderedSourceKey: "",
  lastRenderedUiRevision: 0,
  lastRenderedGlobalVolume: 1,

  init() {
    this.createLauncher();
    this.updateLauncher();
    this.setupLauncherPositioning();
    this.startGMSync();
  },

  getApp() {
    if (!this.app) this.app = new ImpTheaterWindow();
    return this.app;
  },

  open() {
    const app = this.getApp();
    if (app.rendered) {
      app.show();
      return;
    }

    this.hidden = false;
    app.render(true);
  },

  toggle() {
    const app = this.getApp();
    if (app.rendered && !this.hidden) app.hide();
    else this.open();
  },

  render() {
    if (this.app?.rendered) this.app.render(false);
    this.updateLauncher();
  },

  syncToState(state) {
    const nextKey = impTheaterSourceKey(state);
    const nextGlobalVolume = this.app?._normalizeVolumeMultiplier(state.globalVolume) ?? 1;
    if (this.app?.rendered && this.lastRenderedSourceKey && this.lastRenderedSourceKey !== nextKey) {
      this.render();
      return;
    }

    if (this.app?.rendered && this.lastRenderedUiRevision !== (state.uiRevision ?? 0)) {
      this.app._refreshLists(state);
      this.updateLauncher();
      return;
    }

    if (this.app?.rendered && Math.abs(this.lastRenderedGlobalVolume - nextGlobalVolume) > 0.001) {
      this.lastRenderedGlobalVolume = nextGlobalVolume;
      this.app._applyLocalVolume(undefined, state);
      const slider = this.app._getWindowElement()?.querySelector("[data-action='global-volume']");
      if (slider) slider.value = String(nextGlobalVolume);
      this.updateLauncher();
      return;
    }

    if (this.app?.rendered) this.app._applyState();
    this.updateLauncher();
  },

  applyState() {
    if (this.app?.rendered) this.app._applyState();
    this.updateLauncher();
  },

  startGMSync() {
    if (this._gmSyncTimer) window.clearInterval(this._gmSyncTimer);
    this._gmSyncTimer = null;
  },

  createLauncher() {
    if (document.getElementById("imp-theater-launcher")) return;

    const launcher = document.createElement("div");
    launcher.id = "imp-theater-launcher";
    launcher.innerHTML = `
      <button type="button" data-action="toggle">
        <i class="fas fa-film"></i>
        <span></span>
      </button>
    `;
    launcher.addEventListener("click", () => this.toggle());
    document.body.appendChild(launcher);
    this.setupLauncherPositioning();
  },

  setupLauncherPositioning() {
    window.removeEventListener("resize", this._launcherResizeHandler);
    this._launcherResizeHandler = () => this.positionLauncher();
    window.addEventListener("resize", this._launcherResizeHandler);

    window.setTimeout(() => this.positionLauncher(), 0);
    window.setTimeout(() => this.positionLauncher(), 500);
    this._launcherPositionTimer ??= window.setInterval(() => this.positionLauncher(), 750);
  },

  positionLauncher() {
    const launcher = document.getElementById("imp-theater-launcher");
    if (!launcher) return;

    const counter = document.getElementById("imp-counter-launcher");
    const players = document.getElementById("players");
    const defaultBottom = 116;
    let bottom = defaultBottom;

    if (counter && getComputedStyle(counter).display !== "none") {
      const rect = counter.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) bottom = Math.max(bottom, window.innerHeight - rect.top + 8);
    } else if (players) {
      const rect = players.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
      if (visible) bottom = Math.max(bottom, window.innerHeight - rect.top + 44);
    }

    launcher.style.bottom = `${Math.round(bottom)}px`;
  },

  updateLauncher() {
    const launcher = document.getElementById("imp-theater-launcher");
    if (!launcher) return;

    const hidden = !game.settings.get(IMP_THEATER_MODULE_ID, "showLauncher");
    launcher.classList.toggle("is-hidden", hidden);
    launcher.classList.toggle("is-open", Boolean(this.app?.rendered && !this.hidden));
    launcher.classList.toggle("is-playing", Boolean(impTheaterState().playing));
    launcher.querySelector("span").textContent = impTheaterT("UI.Launcher");
    launcher.querySelector("button").title = impTheaterT("UI.ToggleTitle");
    this.positionLauncher();
  }
};

function registerImpTheaterSettings() {
  game.settings.register(IMP_THEATER_MODULE_ID, "roomState", {
    name: "IMPTHEATER.Settings.RoomState.Name",
    scope: "world",
    config: false,
    type: Object,
    default: impTheaterDefaultState(),
    onChange: (state) => {
      impTheaterTransientState = foundry.utils.deepClone(state);
      ImpTheaterManager.syncToState(state);
    }
  });

  game.settings.register(IMP_THEATER_MODULE_ID, "showLauncher", {
    name: "IMPTHEATER.Settings.ShowLauncher.Name",
    hint: "IMPTHEATER.Settings.ShowLauncher.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => ImpTheaterManager.updateLauncher()
  });

  game.settings.register(IMP_THEATER_MODULE_ID, "autoOpenOnPlay", {
    name: "IMPTHEATER.Settings.AutoOpenOnPlay.Name",
    hint: "IMPTHEATER.Settings.AutoOpenOnPlay.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(IMP_THEATER_MODULE_ID, "syncTolerance", {
    name: "IMPTHEATER.Settings.SyncTolerance.Name",
    hint: "IMPTHEATER.Settings.SyncTolerance.Hint",
    scope: "client",
    config: true,
    type: Number,
    default: 1.5
  });

  game.settings.register(IMP_THEATER_MODULE_ID, "localVolume", {
    name: "IMPTHEATER.Settings.LocalVolume.Name",
    scope: "client",
    config: false,
    type: Number,
    default: 1
  });

  game.settings.register(IMP_THEATER_MODULE_ID, "windowState", {
    name: "IMPTHEATER.Settings.WindowState.Name",
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });
}

function registerImpTheaterSocket() {
  game.socket.on(IMP_THEATER_SOCKET, (payload) => {
    if (payload?.action !== "state") return;
    const state = foundry.utils.mergeObject(impTheaterDefaultState(), payload.state || {}, { inplace: false });
    impTheaterTransientState = foundry.utils.deepClone(state);
    const app = ImpTheaterManager.getApp();
    if (state.playing && game.settings.get(IMP_THEATER_MODULE_ID, "autoOpenOnPlay") && !app.rendered) {
      ImpTheaterManager.open();
      return;
    }
    ImpTheaterManager.syncToState(state);
  });
}

function registerImpTheaterControls() {
  Hooks.on("getSceneControlButtons", (controls) => {
    const tokenControls = controls.find((control) => control.name === "token") || controls[0];
    if (!tokenControls?.tools) return;

    tokenControls.tools.push({
      name: "imp-theater",
      title: "Imp Theater",
      icon: "fas fa-film",
      button: true,
      onClick: () => ImpTheaterManager.toggle()
    });
  });
}

Hooks.once("init", () => {
  registerImpTheaterSettings();
  registerImpTheaterControls();
});

Hooks.once("ready", () => {
  registerImpTheaterSocket();
  ImpTheaterManager.init();

  game.impTheater = {
    open: () => ImpTheaterManager.open(),
    toggle: () => ImpTheaterManager.toggle(),
    state: () => impTheaterState(),
    setState: (state) => game.user?.isGM ? impTheaterSetState(state) : null
  };
});

