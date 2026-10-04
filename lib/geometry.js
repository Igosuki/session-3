/* lib/geometry.js
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

export function to_relative(rect, monitor) {
    return { x: rect.x - monitor.x, y: rect.y - monitor.y, width: rect.width, height: rect.height };
}

export function to_absolute(rel, monitor) {
    return { x: rel.x + monitor.x, y: rel.y + monitor.y, width: rel.width, height: rel.height };
}

export function rect_string(rect) {
    return `${rect.x},${rect.y}+${rect.width}x${rect.height}`;
}

export function rects_equal(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// Size is shrunk first so the top-left clamp cannot push the window out of the area.
export function clamp_to_area(rect, area) {
    const width = Math.max(1, Math.min(rect.width, area.width));
    const height = Math.max(1, Math.min(rect.height, area.height));
    const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - 1);
    const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - 1);
    return { x, y, width, height };
}

// Index of the monitor rect containing the rect's center, else the nearest by center distance.
export function monitor_containing(rect, monitors) {
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    let best = -1, best_dist = Infinity;
    monitors.forEach((m, i) => {
        const dx = Math.max(m.x - cx, 0, cx - (m.x + m.width));
        const dy = Math.max(m.y - cy, 0, cy - (m.y + m.height));
        const dist = dx * dx + dy * dy;
        if (dist < best_dist) { best_dist = dist; best = i; }
    });
    return best;
}

const mode_of = state => ({
    h: state['maximized-horizontal'],
    v: state['maximized-vertical'],
    fs: state.fullscreen,
});

// `cycle`: geometry is ignored while locked, so the window must be unlocked first.
export function window_mode_plan(restore_state, current_state, monitor_differs) {
    let want = mode_of(restore_state);
    let have = mode_of(current_state);
    let state_differs = want.h !== have.h || want.v !== have.v || want.fs !== have.fs;
    let locked = have.h || have.v || have.fs;
    return { want, have, state_differs, locked, cycle: locked && (state_differs || monitor_differs) };
}
