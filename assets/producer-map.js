const MAPLIBRE_SRC = 'https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js';
const LEVEL_ZOOMS = {
  world: 2.4,
  country: 4.2,
  region: 5.8,
};
const COUNTRY_ZOOM = 3.4;
const REGION_ZOOM = 5.2;

/**
 * @typedef {object} ProducerLocation
 * @property {string} name
 * @property {string} address
 * @property {string} continent
 * @property {string} country
 * @property {string} region
 * @property {number} lat
 * @property {number} lng
 * @property {string} mapsUrl
 */

/**
 * @typedef {object} ProducerGroup
 * @property {string} id
 * @property {'continent' | 'country' | 'region'} level
 * @property {string} name
 * @property {string} country
 * @property {string} continent
 * @property {[number, number]} center
 * @property {ProducerLocation[]} locations
 */

/**
 * Loads MapLibre GL JS once and resolves with the global.
 * @returns {Promise<typeof window.maplibregl>}
 */
function loadMapLibre(src = MAPLIBRE_SRC) {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.maplibregl), { once: true });
      existing.addEventListener('error', () => reject(new Error('maplibre')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve(window.maplibregl);
    script.onerror = () => reject(new Error('maplibre'));
    document.head.append(script);
  });
}

/**
 * @param {number} zoom
 * @returns {'continent' | 'country' | 'region'}
 */
function levelForZoom(zoom) {
  if (zoom < COUNTRY_ZOOM) return 'continent';
  if (zoom < REGION_ZOOM) return 'country';
  return 'region';
}

/**
 * @param {string} value
 * @returns {string}
 */
function safeHttpUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    return '';
  }
  return '';
}

/**
 * @param {ProducerLocation} location
 * @returns {string}
 */
function mapsHref(location) {
  const provided = safeHttpUrl(location.mapsUrl);
  if (provided) return provided;
  return `https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lng}#map=15/${location.lat}/${location.lng}`;
}

/**
 * @param {ProducerLocation[]} locations
 * @returns {[number, number]}
 */
function centroid(locations) {
  let lat = 0;
  let lng = 0;
  for (const location of locations) {
    lat += location.lat;
    lng += location.lng;
  }
  return [lng / locations.length, lat / locations.length];
}

/**
 * @param {ProducerLocation[]} locations
 * @param {'continent' | 'country' | 'region'} level
 * @returns {ProducerGroup[]}
 */
function groupLocations(locations, level) {
  /** @type {Map<string, ProducerLocation[]>} */
  const buckets = new Map();

  for (const location of locations) {
    const continent = location.continent || '—';
    const country = location.country || '—';
    const region = location.region || location.name;
    let key = continent;
    if (level === 'country') key = `${continent}::${country}`;
    if (level === 'region') key = `${country}::${region}`;

    const bucket = buckets.get(key);
    if (bucket) bucket.push(location);
    else buckets.set(key, [location]);
  }

  const lang = document.documentElement.lang || 'en';
  const groups = [];
  for (const [id, members] of buckets) {
    const first = members[0];
    let name = first.continent || '—';
    if (level === 'country') name = first.country || '—';
    if (level === 'region') name = first.region || first.name;
    groups.push({
      id,
      level,
      name,
      country: first.country || '',
      continent: first.continent || '',
      center: centroid(members),
      locations: members,
    });
  }

  groups.sort((a, b) => a.name.localeCompare(b.name, lang));
  return groups;
}

/**
 * Beige political map. Land is the background; OpenMapTiles water polygons
 * are painted in the lighter sea colour from the design. Roads and labels stay off.
 * @param {string} tilesUrl
 */
function mapStyle(tilesUrl) {
  return {
    version: 8,
    sources: {
      openmaptiles: {
        type: 'vector',
        url: tilesUrl,
      },
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#c2af88' },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        paint: { 'fill-color': '#e3d5ba' },
      },
      {
        id: 'boundary',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1]],
        paint: {
          'line-color': '#a89870',
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.4, 6, 1.1],
        },
      },
    ],
  };
}

class ProducerMap extends HTMLElement {
  /** @type {maplibregl.Map | null} */
  #map = null;
  /** @type {maplibregl.Marker[]} */
  #markers = [];
  /** @type {ProducerLocation[]} */
  #locations = [];
  /** @type {'continent' | 'country' | 'region' | null} */
  #level = null;
  /** @type {string | null} */
  #selectedId = null;
  /** @type {((event: KeyboardEvent) => void) | null} */
  #onKeyDown = null;
  /** @type {(() => void) | null} */
  #onResize = null;

  connectedCallback() {
    if (this.dataset.ready === 'true') return;
    this.dataset.ready = 'true';
    queueMicrotask(() => {
      if (!this.isConnected) return;
      this.#locations = this.#readLocations();
      this.#onKeyDown = (event) => {
        if (event.key === 'Escape') this.#closePanel();
      };
      document.addEventListener('keydown', this.#onKeyDown);
      this.#onResize = () => this.#map?.resize();
      window.addEventListener('resize', this.#onResize);
      this.#worldButton?.addEventListener('click', () => this.#showWorld());
      this.#closeButton?.addEventListener('click', () => this.#closePanel());
      this.#start();
    });
  }

  disconnectedCallback() {
    if (this.#onKeyDown) document.removeEventListener('keydown', this.#onKeyDown);
    if (this.#onResize) window.removeEventListener('resize', this.#onResize);
    this.#clearMarkers();
    this.#map?.remove();
    this.#map = null;
    this.dataset.ready = 'false';
  }

  async #start() {
    try {
      const maplibregl = await loadMapLibre(this.dataset.maplibreSrc || MAPLIBRE_SRC);
      if (!this.isConnected) return;

      const tilesUrl = this.dataset.tilesUrl || 'https://tiles.openfreemap.org/planet';
      this.#map = new maplibregl.Map({
        container: this.#canvas,
        style: mapStyle(tilesUrl),
        center: [10, 48],
        zoom: 3.2,
        minZoom: 1.4,
        maxZoom: 8,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        cooperativeGestures: false,
      });
      this.#map.touchZoomRotate.disableRotation();

      this.#map.on('load', () => {
        this.#map.resize();
        this.#fitInitial();
        this.#sync();
      });
      this.#map.on('moveend', () => this.#sync());
    } catch {
      this.#showError();
    }
  }

  #fitInitial() {
    if (!this.#map || this.#locations.length === 0) return;
    const maplibregl = window.maplibregl;
    const bounds = new maplibregl.LngLatBounds();
    for (const location of this.#locations) bounds.extend([location.lng, location.lat]);
    this.#map.fitBounds(bounds, {
      padding: 88,
      maxZoom: LEVEL_ZOOMS.region,
      duration: 0,
    });
  }

  #sync() {
    if (!this.#map) return;
    const zoom = this.#map.getZoom();
    const level = levelForZoom(zoom);
    if (this.#worldButton) this.#worldButton.hidden = zoom < COUNTRY_ZOOM;
    if (this.#hint) {
      const hints = this.#i18n.hints || {};
      this.#hint.textContent = this.#locations.length ? hints[level] || '' : this.#i18n.empty || '';
    }
    if (level !== 'region' && this.#selectedId) this.#closePanel(false);
    if (level !== this.#level) {
      this.#level = level;
      this.#renderMarkers();
    }
  }

  #renderMarkers() {
    if (!this.#map || !this.#level) return;
    this.#clearMarkers();
    const maplibregl = window.maplibregl;
    const groups = groupLocations(this.#locations, this.#level);

    for (const group of groups) {
      const selected = group.id === this.#selectedId;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `producer-map__pin${selected ? ' producer-map__pin--selected' : ''}`;
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      button.setAttribute('aria-label', `${group.name}, ${group.locations.length}`);

      const dot = document.createElement('img');
      dot.className = 'producer-map__dot';
      dot.alt = '';
      dot.width = 14;
      dot.height = 14;
      dot.src = selected ? this.dataset.pinSelected || '' : this.dataset.pin || '';

      const label = document.createElement('span');
      label.className = 'producer-map__label';
      const name = document.createElement('span');
      name.className = 'producer-map__pin-name';
      name.textContent = group.name;
      const count = document.createElement('span');
      count.className = 'producer-map__pin-count';
      count.textContent = String(group.locations.length);
      label.append(name, count);

      if (selected) button.append(label, dot);
      else button.append(dot, label);

      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.#openGroup(group);
      });

      const marker = new maplibregl.Marker({
        element: button,
        anchor: selected ? 'right' : 'left',
        offset: selected ? [7, 0] : [-7, 0],
      })
        .setLngLat(group.center)
        .addTo(this.#map);

      const element = marker.getElement();
      element.style.zIndex = selected ? '2' : '1';
      this.#markers.push(marker);
    }
  }

  /**
   * @param {ProducerGroup} group
   */
  #openGroup(group) {
    if (!this.#map) return;
    if (group.level !== 'region') {
      const zoom = group.level === 'continent' ? LEVEL_ZOOMS.country : LEVEL_ZOOMS.region;
      this.#map.easeTo({
        center: group.center,
        zoom,
        duration: this.#motionDuration(),
      });
      return;
    }

    if (this.#selectedId === group.id) {
      this.#closePanel();
      return;
    }

    this.#selectedId = group.id;
    this.#level = 'region';
    this.#renderMarkers();
    this.#fillPanel(group);
    this.#reveal(group.center);
  }

  /**
   * @param {ProducerGroup} group
   */
  #fillPanel(group) {
    const panel = this.#panel;
    if (!panel) return;
    const lang = document.documentElement.lang || 'en';
    const places = group.locations.slice().sort((a, b) => a.name.localeCompare(b.name, lang));

    if (this.#country) this.#country.textContent = group.country;
    if (this.#region) this.#region.textContent = group.name;
    if (this.#total) this.#total.textContent = this.#producerLabel(places.length);

    const list = this.#list;
    if (list) {
      list.replaceChildren();
      for (const location of places) {
        const row = document.createElement('div');
        row.className = 'producer-map__producer';

        const text = document.createElement('div');
        text.className = 'producer-map__producer-text';
        const name = document.createElement('p');
        name.className = 'producer-map__producer-name';
        name.textContent = location.name;
        text.append(name);
        if (location.address) {
          const address = document.createElement('p');
          address.className = 'producer-map__producer-address';
          address.textContent = location.address;
          text.append(address);
        }

        const link = document.createElement('a');
        link.className = 'producer-map__maps';
        link.href = mapsHref(location);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `${this.#i18n.maps || 'Maps'} ↗`;

        row.append(text, link);
        list.append(row);
      }
    }

    panel.hidden = false;
    this.classList.add('producer-map--open');
    this.#closeButton?.focus();
  }

  /**
   * @param {boolean} [render]
   */
  #closePanel(render = true) {
    this.#selectedId = null;
    if (this.#panel) this.#panel.hidden = true;
    this.classList.remove('producer-map--open');
    if (render && this.#level === 'region') this.#renderMarkers();
  }

  #showWorld() {
    if (!this.#map) return;
    this.#closePanel(false);
    const center = this.#locations.length ? centroid(this.#locations) : /** @type {[number, number]} */ ([10, 48]);
    this.#map.easeTo({
      center,
      zoom: LEVEL_ZOOMS.world,
      duration: this.#motionDuration(),
    });
  }

  /**
   * Nudge the map so a selected region sits clear of the panel.
   * @param {[number, number]} lngLat
   */
  #reveal(lngLat) {
    if (!this.#map || !this.#panel || !this.#canvas) return;
    const point = this.#map.project(lngLat);
    const panel = this.#panel.getBoundingClientRect();
    const mapRect = this.#canvas.getBoundingClientRect();
    const panelLeft = panel.left - mapRect.left;
    const panelTop = panel.top - mapRect.top;
    let dx = 0;
    let dy = 0;
    if (point.x > panelLeft - 28 && point.x < panel.right - mapRect.left) dx = point.x - (panelLeft - 36);
    if (point.y > panelTop && point.y < panel.bottom - mapRect.top && panelTop > mapRect.height * 0.4) {
      dy = point.y - (panelTop - 28);
    }
    if (dx || dy) this.#map.panBy([dx, dy], { duration: this.#motionDuration() });
  }

  /**
   * @param {number} count
   */
  #producerLabel(count) {
    if (count === 1) return this.#i18n.producersOne || String(count);
    return (this.#i18n.producersOther || String(count)).replace(/\b2\b/, String(count));
  }

  #showError() {
    if (this.#hint && this.#i18n.error) this.#hint.textContent = this.#i18n.error;
  }

  #motionDuration() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 800;
  }

  #clearMarkers() {
    for (const marker of this.#markers) marker.remove();
    this.#markers = [];
  }

  /**
   * @returns {ProducerLocation[]}
   */
  #readLocations() {
    const script = this.querySelector('script[data-locations]');
    if (!script?.textContent) return [];
    try {
      const parsed = JSON.parse(script.textContent);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => ({
          name: String(entry.name || ''),
          address: String(entry.address || ''),
          continent: String(entry.continent || ''),
          country: String(entry.country || ''),
          region: String(entry.region || ''),
          lat: Number(entry.lat),
          lng: Number(entry.lng),
          mapsUrl: String(entry.mapsUrl || ''),
        }))
        .filter((entry) => entry.name && Number.isFinite(entry.lat) && Number.isFinite(entry.lng));
    } catch {
      return [];
    }
  }

  get #i18n() {
    const script = this.querySelector('script[data-i18n]');
    if (!script?.textContent) return {};
    try {
      return JSON.parse(script.textContent);
    } catch {
      return {};
    }
  }

  get #canvas() {
    const canvas = this.querySelector('.producer-map__canvas');
    if (!(canvas instanceof HTMLElement)) throw new Error('Map canvas missing');
    return canvas;
  }

  get #worldButton() {
    return this.querySelector('.producer-map__world');
  }

  get #closeButton() {
    const button = this.querySelector('.producer-map__close');
    return button instanceof HTMLButtonElement ? button : null;
  }

  get #panel() {
    return this.querySelector('.producer-map__panel');
  }

  get #hint() {
    return this.querySelector('.producer-map__hint');
  }

  get #country() {
    return this.querySelector('.producer-map__country');
  }

  get #region() {
    return this.querySelector('.producer-map__region');
  }

  get #total() {
    return this.querySelector('.producer-map__total');
  }

  get #list() {
    return this.querySelector('.producer-map__list');
  }
}

if (!customElements.get('producer-map')) {
  customElements.define('producer-map', ProducerMap);
}
