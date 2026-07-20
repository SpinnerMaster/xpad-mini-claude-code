import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { ClaudeState } from '../../shared/types';
import { LCD_HEIGHT, LCD_WIDTH, XpadProtocol } from './protocol';

/** What the LCD should express; resolved to a concrete animation at play time. */
export type ClawdRole =
  | 'idle'
  | 'working'
  | 'attention'
  | 'done'
  | 'approve'
  | 'reject'
  | 'dictation';

const STATE_ROLE: Record<ClaudeState, ClawdRole> = {
  idle: 'idle',
  working: 'working',
  attention: 'attention',
  done: 'done',
};

/** How long a key-press reaction plays before returning to the state animation. */
const ONESHOT_MS = 1800;
/** While continuously working, rotate to the next pool animation this often. */
const WORKING_ROTATE_MS = 45_000;

interface LoadedAnimation {
  /** RGB565-LE frames, LCD_WIDTH x LCD_HEIGHT (pre-converted at load) */
  frames: Buffer[];
  /** per-frame delay in ms */
  delays: number[];
}

function rgbaToRgb565(rgba: Buffer): Buffer {
  const out = Buffer.alloc(LCD_WIDTH * LCD_HEIGHT * 2);
  for (let i = 0; i < LCD_WIDTH * LCD_HEIGHT; i++) {
    const v =
      ((rgba[i * 4] >> 3) << 11) | ((rgba[i * 4 + 1] >> 2) << 5) | (rgba[i * 4 + 2] >> 3);
    out.writeUInt16LE(v, i * 2);
  }
  return out;
}

/**
 * Role -> animation names, in priority order. The first animation of the list
 * that was actually loaded wins; 'working' cycles through all loaded entries.
 * External animations (assets/clawd-external, imported from KebeliSamet0/clawd
 * by tools/import-clawd-gifs.js — gitignored, art is All-Rights-Reserved) are
 * preferred; the committed procedural set is the fallback.
 */
const ROLE_ANIMATIONS: Record<ClawdRole, string[]> = {
  idle: ['sleeping'],
  working: ['typing', 'thinking', 'building', 'debugger', 'working'],
  attention: ['notification', 'alert'],
  done: ['happy'],
  approve: ['react-double-jump', 'approve'],
  reject: ['react-annoyed', 'reject'],
  dictation: ['carrying', 'dictation'],
};

/** Fixed fps used for the procedural fallback set (no manifest.json). */
const FALLBACK_FPS: Record<string, number> = {
  sleeping: 4,
  working: 8,
  alert: 6,
  happy: 6,
  approve: 8,
  reject: 8,
  dictation: 6,
};

export class LcdEngine {
  private animations = new Map<string, LoadedAnimation>();
  private role: ClawdRole = 'idle';
  private currentAnim = 'sleeping';
  private oneShot: { anim: string; until: number } | null = null;
  private frameIndex = 0;
  private timer: NodeJS.Timeout | null = null;
  private workingPool: string[] = [];
  private workingPoolIndex = -1;
  private workingRotatedAt = 0;

  constructor(
    private protocol: XpadProtocol,
    private assetRoot: string,
    /** Per-user art dir that survives app reinstalls (imported pixel art). */
    private externalDir: string
  ) {}

  loadAssets(): void {
    this.animations.clear();
    // Procedural fallback first; external sets override. The shared per-user
    // dir loads last: it survives reinstalls (installer builds ship without
    // the fan art, so this is where imported art actually lives).
    this.loadDir(path.join(this.assetRoot, 'clawd'));
    this.loadDir(path.join(this.assetRoot, 'clawd-external'));
    this.loadDir(this.externalDir);
    this.workingPool = ROLE_ANIMATIONS.working.filter((a) => this.animations.has(a));
    // Don't mix the procedural 'working' into a rotation with external anims.
    if (this.workingPool.length > 1) {
      this.workingPool = this.workingPool.filter((a) => a !== 'working');
    }
    console.log(
      `[lcd] loaded ${this.animations.size} animations; working pool: ${this.workingPool.join(', ')}`
    );
    this.currentAnim = this.resolve(this.role);
  }

  private loadDir(root: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const name of entries) {
      const dir = path.join(root, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.png'))
          .sort((a, b) => parseInt(a) - parseInt(b));
        const frames: Buffer[] = [];
        for (const file of files) {
          const png = PNG.sync.read(fs.readFileSync(path.join(dir, file)));
          if (png.width !== LCD_WIDTH || png.height !== LCD_HEIGHT) {
            console.error(`[lcd] ${name}/${file}: unexpected size ${png.width}x${png.height}`);
            continue;
          }
          frames.push(rgbaToRgb565(png.data));
        }
        if (frames.length === 0) continue;

        let delays: number[];
        const manifestPath = path.join(dir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          delays = frames.map((_, i) => Number(manifest.delays?.[i]) || 100);
        } else {
          const fps = FALLBACK_FPS[name] ?? 6;
          delays = frames.map(() => 1000 / fps);
        }
        this.animations.set(name, { frames, delays });
      } catch (err) {
        console.error(`[lcd] failed loading ${dir}`, err);
      }
    }
  }

  private resolve(role: ClawdRole): string {
    if (role === 'working' && this.workingPool.length > 0) {
      if (this.workingPoolIndex < 0) this.workingPoolIndex = 0;
      return this.workingPool[this.workingPoolIndex % this.workingPool.length];
    }
    for (const name of ROLE_ANIMATIONS[role]) {
      if (this.animations.has(name)) return name;
    }
    return this.currentAnim;
  }

  setState(state: ClaudeState): void {
    const role = STATE_ROLE[state];
    if (role === this.role) return;
    if (role === 'working') {
      // Rotate the pool every time we (re-)enter working.
      this.workingPoolIndex++;
      this.workingRotatedAt = Date.now();
    }
    this.role = role;
    this.currentAnim = this.resolve(role);
    this.frameIndex = 0;
    this.frameShownAt = 0;
    this.reschedule();
  }

  /** Play a key-press reaction, then fall back to the state animation. */
  playOneShot(role: Extract<ClawdRole, 'approve' | 'reject' | 'dictation'>): void {
    this.oneShot = { anim: this.resolve(role), until: Date.now() + ONESHOT_MS };
    this.frameIndex = 0;
    this.frameShownAt = 0;
    this.reschedule();
  }

  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private activeAnimation(): string {
    if (this.oneShot) {
      if (Date.now() < this.oneShot.until) return this.oneShot.anim;
      this.oneShot = null;
    }
    // Long continuous work session: rotate the pool periodically.
    if (
      this.role === 'working' &&
      this.workingPool.length > 1 &&
      Date.now() - this.workingRotatedAt > WORKING_ROTATE_MS
    ) {
      this.workingPoolIndex++;
      this.workingRotatedAt = Date.now();
      this.currentAnim = this.resolve('working');
      this.frameIndex = 0;
      this.frameShownAt = 0;
    }
    return this.currentAnim;
  }

  private epoch = 0;

  private frameShownAt = 0;

  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const myEpoch = ++this.epoch; // invalidate any in-flight async tick
    const tick = async () => {
      if (myEpoch !== this.epoch) return;
      const name = this.activeAnimation();
      const anim = this.animations.get(name);
      if (anim) {
        const idx = this.frameIndex % anim.frames.length;
        if (this.frameShownAt === 0) this.frameShownAt = Date.now();
        await this.protocol.drawLcdFrame(anim.frames[idx]);
        if (myEpoch !== this.epoch) return;
        // Long frame holds are re-ticked in slices: each identical redraw
        // costs one keep-alive packet but keeps the firmware's own UI
        // suppressed (it flashes through after ~0.5 s without traffic).
        const elapsed = Date.now() - this.frameShownAt;
        const delay = anim.delays[idx];
        if (elapsed >= delay - 10) {
          this.frameIndex++;
          this.frameShownAt = 0;
          this.timer = setTimeout(() => void tick(), 10);
        } else {
          this.timer = setTimeout(() => void tick(), Math.min(delay - elapsed, 350));
        }
      } else {
        // Assets missing: retry slowly.
        this.timer = setTimeout(() => void tick(), 1000);
      }
    };
    void tick();
  }
}
