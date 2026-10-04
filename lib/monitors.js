/* lib/monitors.js
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

function plain(rect) {
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

// Monitor indices change across boots; the connector name is the stable key.
export function connector_for_index(index) {
    if (index < 0) return null;
    const logicals = global.backend.get_monitor_manager().get_logical_monitors();
    const logical = logicals.find(l => l.get_number() === index);
    return logical?.get_monitors()[0]?.get_connector() ?? null;
}

export function index_for_connector(name) {
    if (!name) return -1;
    return global.backend.get_monitor_manager().get_monitor_for_connector(name);
}

export function monitor_geometry(index) {
    return plain(global.display.get_monitor_geometry(index));
}

// Without a window, uses the active workspace.
export function work_area(window, index) {
    const workspace = window?.get_workspace() ?? global.workspace_manager.get_active_workspace();
    return plain(workspace.get_work_area_for_monitor(index));
}
