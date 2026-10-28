/**
 * Counts down to a shop-timezone deadline, refreshing once per minute.
 * The deadline is a unix timestamp in seconds on `data-end`.
 */
class AnnouncementCountdown extends HTMLElement {
  /** @type {number | undefined} */
  #timer;

  connectedCallback() {
    this.#render();
    this.#schedule();
    document.addEventListener('visibilitychange', this.#onVisibility);
  }

  disconnectedCallback() {
    this.#clear();
    document.removeEventListener('visibilitychange', this.#onVisibility);
  }

  #onVisibility = () => {
    if (document.hidden) return;
    this.#render();
    this.#schedule();
  };

  #clear() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  get #end() {
    const seconds = Number(this.dataset.end);
    return Number.isFinite(seconds) ? seconds * 1000 : NaN;
  }

  #schedule() {
    this.#clear();

    const end = this.#end;
    if (!Number.isFinite(end)) return;

    const remaining = end - Date.now();
    if (remaining <= 0) return;

    const intoMinute = remaining % 60000;
    const delay = (intoMinute === 0 ? 60000 : intoMinute) + 50;

    this.#timer = window.setTimeout(() => {
      this.#render();
      this.#schedule();
    }, delay);
  }

  #render() {
    const end = this.#end;
    const output = this.querySelector('[data-countdown-value]');
    if (!output || !Number.isFinite(end)) return;

    const remaining = Math.max(0, end - Date.now());
    const totalMinutes = Math.floor(remaining / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const daysLabel = this.dataset.labelDays || 'dage';
    const hoursLabel = this.dataset.labelHours || 't';
    const minutesLabel = this.dataset.labelMinutes || 'min';
    const hoursText = String(hours).padStart(2, '0');
    const minutesText = String(minutes).padStart(2, '0');

    output.textContent = `${days} ${daysLabel}  ${hoursText} ${hoursLabel}  ${minutesText} ${minutesLabel}`;
  }
}

if (!customElements.get('announcement-countdown')) {
  customElements.define('announcement-countdown', AnnouncementCountdown);
}
