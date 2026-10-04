/* lib/settle.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';

import { opt } from './config.js';
import { debug } from './log.js';

const DEBOUNCE_MS = 200;
const MAX_REAPPLY = 10;

function covers(rect, target) {
    return rect.x === target.x && rect.y === target.y &&
           rect.width === target.width && rect.height === target.height;
}

// Clients (Electron, Java, browsers) move, resize and retitle their windows after first map;
// a Settler re-applies the restored geometry for opt.settle_seconds.
export class Settler {
    // on_idle fires whenever the last watch ends, except through destroy().
    constructor({ on_idle = null } = {}) {
        this._watches = new Map();
        this._on_idle = on_idle;
        this._grab = 0;
    }

    get active() {
        return this._watches.size > 0;
    }

    // apply_fn re-applies the target; target_fn returns the absolute target rect (null to skip),
    // on_title runs on a debounced title change, geometry=false watches titles only.
    // Re-watching a window keeps its original deadline.
    watch(current, restore, apply_fn, { target_fn = null, on_title = null, geometry = true } = {}) {
        let window = current.window;
        let deadline = null;
        let previous = this._watches.get(window);
        if (previous) {
            deadline = previous.deadline;
            this._stop(previous, false);
        }
        if (deadline === null) deadline = GLib.get_monotonic_time() + opt.settle_seconds * 1000000;
        let remaining_ms = Math.floor((deadline - GLib.get_monotonic_time()) / 1000);
        if (remaining_ms <= 0) {
            if (previous) this._notify_idle();
            return;
        }

        let w = {
            window, current, restore, apply_fn, target_fn, on_title, geometry,
            deadline, count: 0, busy: false, dirty_title: false,
            timer: 0, expiry: 0, signals: [], actor: null, actor_signal: 0,
        };
        this._watches.set(window, w);

        let poke = () => this._schedule(w);
        w.signals.push(window.connect('notify::title', () => { w.dirty_title = true; poke(); }));
        if (geometry) {
            w.signals.push(window.connect('size-changed', poke));
            w.signals.push(window.connect('position-changed', poke));
        }
        w.signals.push(window.connect('unmanaged', () => this._stop(w)));

        let actor = window.get_compositor_private();
        if (actor && geometry) {
            w.actor = actor;
            w.actor_signal = actor.connect('first-frame', poke);
        }

        w.expiry = GLib.timeout_add(GLib.PRIORITY_DEFAULT, remaining_ms, () => {
            w.expiry = 0;
            debug(4, `Settled: ${restore.class} (${restore.id})`);
            this._stop(w);
            return GLib.SOURCE_REMOVE;
        });

        if (!this._grab) {
            this._grab = global.display.connect('grab-op-begin', (display, grab_window) => {
                let w = this._watches.get(grab_window);
                if (w) {
                    debug(3, `User grab: ${w.restore.class} (${w.restore.id}) -> stop settling`);
                    this._stop(w);
                }
            });
        }

        this._schedule(w);
    }

    unwatch(window) {
        let w = this._watches.get(window);
        if (w) this._stop(w);
    }

    destroy() {
        for (let w of [...this._watches.values()]) this._stop(w, false);
        this._on_idle = null;
        this._release_grab();
    }

    _schedule(w) {
        if (w.busy || w.timer || this._watches.get(w.window) !== w) return;
        w.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            w.timer = 0;
            try {
                this._settle(w);
            } catch (error) {
                debug(1, `Settle failed: ${error.stack ?? error}`);
                this._stop(w);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _settle(w) {
        if (this._watches.get(w.window) !== w) return;

        if (w.dirty_title) {
            w.dirty_title = false;
            try {
                w.on_title?.(w.window);
            } catch (error) {
                debug(1, `Title handler failed: ${error.stack ?? error}`);
            }
            if (this._watches.get(w.window) !== w) return; // Replaced by a retarget
        }
        if (!w.geometry) return;

        let window = w.window;
        if (window.is_fullscreen() || window.maximized_horizontally || window.maximized_vertically) return;

        let target = w.target_fn?.();
        if (w.target_fn && !target) return;
        if (target && covers(window.get_frame_rect(), target)) return;

        if (w.count >= MAX_REAPPLY) {
            debug(2, `${w.restore.class} (${w.restore.id}) - still moving after ${MAX_REAPPLY} re-applications -> giving up`);
            this._stop(w);
            return;
        }
        w.count++;
        debug(3, `${w.restore.class} (${w.restore.id}) - moved by client -> re-applying (${w.count})`);

        w.busy = true;
        try {
            w.apply_fn();
        } finally {
            w.busy = false;
        }
    }

    _stop(w, notify = true) {
        if (this._watches.get(w.window) === w) this._watches.delete(w.window);

        for (let id of w.signals) {
            try { w.window.disconnect(id); } catch (e) { debug(4, `Window disconnect: ${e.message}`); }
        }
        w.signals = [];
        if (w.actor_signal) {
            try { w.actor.disconnect(w.actor_signal); } catch (e) { debug(4, `Actor disconnect: ${e.message}`); }
            w.actor_signal = 0;
        }
        if (w.timer) GLib.Source.remove(w.timer);
        if (w.expiry) GLib.Source.remove(w.expiry);
        w.timer = w.expiry = 0;

        if (notify) this._notify_idle();
    }

    _notify_idle() {
        if (this._watches.size) return;
        this._release_grab();
        this._on_idle?.();
    }

    _release_grab() {
        if (!this._grab) return;
        global.display.disconnect(this._grab);
        this._grab = 0;
    }
}
