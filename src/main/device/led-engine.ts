import { ClaudeState, KeyId, KeyRoles, StateStyle } from '../../shared/types';
import { Rgb, XpadProtocol } from './protocol';

const FPS = 30;

/**
 * Physical LED layout, calibrated against the device with the user's eyes
 * (2026-07-19). Device indexes: 0,1,2 = key LEDs left/center/right;
 * 3..12 = light bar running RIGHT -> LEFT (3 = right end, 12 = left end).
 * NOT the layout the firmware docs suggested — trust this, it was verified
 * by lighting individual indexes. See docs/PROTOCOL.md.
 */
const KEY_LED: Record<KeyId, number> = { left: 0, center: 1, right: 2 };
/** Bar device indexes ordered left -> right as the user sees them. */
const BAR: number[] = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3];
/** Clockwise ring: bar left -> right, then keys right -> left, and around. */
const RING: number[] = [...BAR, KEY_LED.right, KEY_LED.center, KEY_LED.left];

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const APPROVE_GREEN: Rgb = { r: 0, g: 255, b: 0 };
// Post-gamma target ~(255,40,0): these LEDs read green-strong, more G looks yellow.
const REJECT_ORANGE: Rgb = { r: 255, g: 110, b: 0 };
const DICTATION_GLOW: Rgb = { r: 0x8c, g: 0xb4, b: 0xff }; // neutral blue-white

function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return BLACK;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

function scale(c: Rgb, f: number): Rgb {
  const clamped = Math.max(0, Math.min(1, f));
  return {
    r: c.r * clamped,
    g: c.g * clamped,
    b: c.b * clamped,
  };
}

/**
 * LEDs are linear emitters while our colors are sRGB-ish: without gamma, dim
 * values glow far too bright (a 15% tail reads as "on") and mixed colors wash
 * out (#dc2626 turns pink). Applied once, at the final output step.
 */
const GAMMA = 2.2;

function gammaCorrect(c: Rgb): Rgb {
  return {
    r: Math.round(255 * Math.pow(Math.max(0, c.r) / 255, GAMMA)),
    g: Math.round(255 * Math.pow(Math.max(0, c.g) / 255, GAMMA)),
    b: Math.round(255 * Math.pow(Math.max(0, c.b) / 255, GAMMA)),
  };
}

/**
 * Base glow for the bar during working/building. The bar sits behind a
 * diffuser and runs much dimmer than the key LEDs (5% PWM proved invisible
 * on hardware), so "dim glow" needs ~17% duty post-gamma.
 */
const BAR_BASE = Math.pow(0.17, 1 / GAMMA);
/** Key LEDs are bright and unlidded; a much lower duty reads the same. */
const KEY_BASE = Math.pow(0.06, 1 / GAMMA);

/**
 * Symmetric constant-energy dot: full brightness at the dot's fractional
 * position, quadratic falloff over `width` LEDs on both sides — the peak
 * glides instead of pulsing as it crosses LED boundaries.
 */
function dotLevel(dist: number, width = 2): number {
  const d = Math.abs(dist);
  if (d >= width) return 0;
  const f = 1 - d / width;
  return f * f;
}

/**
 * Renders the current Claude state as LED animation frames at 30 Hz and hands
 * them to the protocol layer.
 *
 *  - scan:  a bright dot with a trailing fade sweeping left -> right (working)
 *  - pulse: smooth sine breathing (done)
 *  - flash: hard 2 Hz on/off (attention)
 *  - steady / off
 */
export class LedEngine {
  private timer: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private state: ClaudeState = 'idle';
  private styles: Record<ClaudeState, StateStyle>;
  private keyRoles: KeyRoles = {};
  private overlay: 'orbit' | null = null;
  private brightness = 1;

  constructor(
    private protocol: XpadProtocol,
    styles: Record<ClaudeState, StateStyle>
  ) {
    this.styles = styles;
  }

  setStyles(styles: Record<ClaudeState, StateStyle>): void {
    this.styles = styles;
  }

  setKeyRoles(roles: KeyRoles): void {
    this.keyRoles = roles;
  }

  /** Driven by the LCD engine's active animation (e.g. 'building' -> orbit). */
  setOverlay(overlay: 'orbit' | null): void {
    this.overlay = overlay;
  }

  setBrightness(brightness: number): void {
    this.brightness = Math.max(0, Math.min(1, brightness));
  }

  setState(state: ClaudeState): void {
    if (state === this.state) return;
    this.state = state;
    this.startedAt = Date.now();
    this.renderFrame();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.renderFrame(), 1000 / FPS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private renderFrame(): void {
    const style = this.styles[this.state];
    const t = (Date.now() - this.startedAt) / 1000;
    const color = hexToRgb(style.color);

    if (this.overlay === 'orbit' && this.state === 'working') {
      this.renderOrbit(t, color);
      return;
    }

    const out: Rgb[] = Array(13).fill(BLACK);
    const fillBar = (c: Rgb) => {
      for (const idx of BAR) out[idx] = c;
    };
    let brightness = 1;

    switch (style.effect) {
      case 'off':
        brightness = 0;
        break;
      case 'steady':
        fillBar(color);
        break;
      case 'pulse': {
        brightness = 0.02 + 0.98 * (0.5 + 0.5 * Math.sin(t * Math.PI)); // ~0.5 Hz breathe
        fillBar(scale(color, brightness));
        break;
      }
      case 'flash': {
        brightness = Math.floor(t * 4) % 2 === 0 ? 1 : 0; // 2 Hz
        fillBar(scale(color, brightness));
        break;
      }
      case 'scan': {
        // Smooth dot gliding left -> right over a dim base, wrapping
        // seamlessly (circular distance): it re-enters on the left as it
        // exits on the right, so the motion never stalls.
        const speed = 8; // LEDs per second
        const n = BAR.length;
        const pos = (t * speed) % n;
        for (let i = 0; i < n; i++) {
          const lin = Math.abs(pos - i);
          const dist = Math.min(lin, n - lin);
          const level = Math.max(BAR_BASE, dotLevel(dist));
          out[BAR[i]] = scale(color, level);
        }
        brightness = KEY_BASE; // keys hold a faint tint while working
        break;
      }
    }

    this.applyKeys(out, color, brightness);
    this.protocol.setLeds(out.map((c) => this.output(c)));
  }

  /** Final output step: global brightness, then gamma. */
  private output(c: Rgb): Rgb {
    return gammaCorrect(this.brightness === 1 ? c : scale(c, this.brightness));
  }

  /**
   * 'building' overlay: the whole ring holds a dim base glow while a
   * full-bright dot glides around it (bar left -> right, then the keys
   * right -> left, and around again).
   */
  private renderOrbit(t: number, color: Rgb): void {
    const speed = 8; // ring positions per second (~1.6 s per lap)
    const n = RING.length;
    const pos = (t * speed) % n;
    const out: Rgb[] = Array(13).fill(BLACK);
    for (let slot = 0; slot < n; slot++) {
      const lin = Math.abs(pos - slot);
      const dist = Math.min(lin, n - lin); // circular distance to the dot
      const idx = RING[slot];
      const isKey = idx < 3;
      // Key LEDs are far brighter than the diffused bar; damp them so the
      // dot reads as one continuous brightness around the loop.
      const level = Math.max(isKey ? KEY_BASE : BAR_BASE, dotLevel(dist) * (isKey ? 0.5 : 1));
      out[idx] = scale(color, level);
    }
    this.protocol.setLeds(out.map((c) => this.output(c)));
  }

  /**
   * Role-aware key LEDs, written into the flat device array:
   *  - attention: approve key solid green, reject key solid orange (steady
   *    while the bar flashes), others dark
   *  - idle: dictation key glows blue-white so it's findable, rest dark
   *  - other states: keys follow the effect brightness/color
   */
  private applyKeys(out: Rgb[], color: Rgb, brightness: number): void {
    if (this.state === 'attention') {
      if (this.keyRoles.approve) out[KEY_LED[this.keyRoles.approve]] = APPROVE_GREEN;
      if (this.keyRoles.reject) out[KEY_LED[this.keyRoles.reject]] = REJECT_ORANGE;
      return;
    }
    if (this.state === 'idle') {
      if (this.keyRoles.dictation) out[KEY_LED[this.keyRoles.dictation]] = DICTATION_GLOW;
      return;
    }
    const c = scale(color, brightness);
    for (const keyId of ['left', 'center', 'right'] as KeyId[]) {
      out[KEY_LED[keyId]] = c;
    }
  }
}
