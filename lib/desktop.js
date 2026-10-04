
/* lib/desktop.js
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

import Meta    from 'gi://Meta';
import GLib    from 'gi://GLib';
import Shell   from 'gi://Shell';

import { opt } from './config.js';
import { debug, notify, _ } from './log.js';
import { args_to_command, compare_command_commstr } from './match.js';

// A Desktop consists of a list of windows and their properties:
export class Desktop {
    constructor(mode='current') {
        if (mode === 'restore') {
            this.windows = this._restore();
        } else {
            this.windows = this._current();
        }
        this._add_window_extras();
        debug(4, `windows = [${mode}]: ${JSON.stringify(this.windows, (key, value) => key === 'window' ? undefined : value, 2)}`);
        debug(3, `Loaded ${mode}`);
    }

    _current() {
        let meta_windows = global.get_window_actors().map(actor => actor.meta_window);
        meta_windows = meta_windows.filter(window => normal(window));

        let windows = {};
        meta_windows.forEach(window => {
            window = this._get_window_details(window);
            windows[window.id] = window;
        });

        return windows;
    }

    _restore() {
        let content = GLib.file_get_contents(opt.filename)[1];
        content = JSON.parse(new TextDecoder().decode(content));
        delete content.opt;

        return content;
    }

    save() {
        let content = this._del_window_extras();
        content.opt = opt;
        content = JSON.stringify(content, null, 2);
        GLib.file_set_contents(opt.filename, content);

        notify(_('Session saved'), _(`Saved session to ${opt.filename}`));
        debug(3, `Saved windows to ${opt.filename}`);

        return true;
    }

    _get_window_details(window) {
        let rect = window.get_frame_rect();
        let pid = window.get_pid();
        let app = Shell.WindowTracker.get_default().get_window_app(window);
        app = app ? app.get_app_info() : null;

        return {
            id: window.get_stable_sequence(),
            class: ( app ? app.get_startup_wm_class() : null ) || window.get_wm_class(),
            title: window.get_title(),
            workspace: window.get_workspace().index() || 0,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            state: this._get_window_state(window),
            pid: pid,
            comm: this._get_comm(pid, app),
            window: window,
        };
    }

    _get_window_state(window) {
        let state = {};

        if (window.minimized) {
            state.minimized = true;
        }
        if (window.maximized_horizontally) {
            state['maximized-horizontal'] = true;
        }
        if (window.maximized_vertically) {
            state['maximized-vertical'] = true;
        }
        if (window.is_fullscreen()) {
            state.fullscreen = true;
        }

        if (window.is_above()) {
            state.above = true;
        }        
        if (window.is_on_all_workspaces()) {
            state.sticky = true;
        }
        if (window.has_focus()) {
            state.focused = true;
        }

        return state;
    }

    _get_comm(pid, app) {
        let command = get_commandline(app); // From app's .desktop file
        let comm = get_pid_comm(pid);       // From /proc/pid/cmdline

        // If command is null, then use comm:
        if (!command) return comm;

        // If command contains %X and comm matches substitutions, then use comm:
        if (command.includes(' %')) {
            let commstr = args_to_command(comm);
            let result = compare_command_commstr(command, commstr);
            debug(4, `_get_comm(): ${command} vs ${commstr} = ${result}`);
            if (result) return comm;
        }

        // Otherwise, use command with %X removed:
        return command.split(' ').filter(arg => !arg.startsWith('%'));

        // Get command line arguments from app's .desktop file:
        function get_commandline(app) {
            if (!app) return null;
            try { // First look for a new-window Exec entry
                let file = new GLib.KeyFile();
                file.load_from_file(app.get_filename(), GLib.KeyFileFlags.NONE);
                return file.get_string('Desktop Action new-window', 'Exec');
            } catch (e) {
                return app.get_commandline();
            }
        }

        // Get command line arguments from /proc/pid/cmdline:
        function get_pid_comm(pid) {
            let content = GLib.file_get_contents(`/proc/${pid}/cmdline`)[1];
            // Arguments are null-byte (\0) separated:
            let command = [];
            let s = 0;
            for (let c = 0; c < content.length; c++) {
                if (content[c] === 0) {
                    command.push(new TextDecoder().decode(content.slice(s, c)));
                    s = c + 1;
                }
            }
            return [...command[0].split(' '), ...command.slice(1)];
        }
    }

    _add_window_extras() {
        // Some properties are not saved; derive window extras:
        for (let window of Object.values(this.windows)) {
            window.group = `${window.pid} ${window.class}`;
            window.geometry = `${window.rect.x},${window.rect.y}+${window.rect.width}x${window.rect.height}`;
            window.command = args_to_command(window.comm);

            [ 'minimized',
              'maximized-horizontal',
              'maximized-vertical',
              'fullscreen',
              'above',
              'sticky',
              'focused',
            ].forEach(state => {
                window.state[state] = window.state[state] || false;
            });
        }
    }

    _del_window_extras() {
        let cleaned = {};
        for (let [id, window] of Object.entries(this.windows)) {
            let _window = Object.assign({}, window);

            delete _window.group;
            delete _window.geometry;
            delete _window.command;
            delete _window.window;

            _window.state = Object.assign({}, _window.state);
            for (let key of Object.keys(_window.state)) {
                if (!_window.state[key]) delete _window.state[key];
            }

            cleaned[id] = _window;
        }
        return cleaned;
    }
}

// Ignore dialog, modal, and other non-windows:
export function normal(window) {
    return window.get_window_type() === Meta.WindowType.NORMAL && !window.get_transient_for();
}
